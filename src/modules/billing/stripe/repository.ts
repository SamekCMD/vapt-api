import { withTransaction, type Database, type Queryable } from "../../../lib/database.js";
import { AppError } from "../../../lib/errors.js";
import type { StripePlanType } from "./schemas.js";

export type StripePlanStatus =
  | "trialing" | "active" | "past_due" | "incomplete" | "unpaid" | "paused"
  | "expired" | "cancelled";

export type OwnedBillingScope = {
  userId: string;
  restaurantId: string;
};

export type BillingScope = OwnedBillingScope & {
  planType: StripePlanType;
  planStatus: StripePlanStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  subscriptionCanceledAt: string | null;
  checkoutSessionId: string | null;
  checkoutPlanType: StripePlanType | null;
  checkoutExpiresAt: string | null;
};

export type PublicBillingStatus = Pick<BillingScope,
  "planType" | "planStatus" | "trialEndsAt" | "currentPeriodEnd" |
  "cancelAtPeriodEnd" | "subscriptionCanceledAt"
> & { canManageBilling: boolean; requiresBillingAction: boolean };

export type PendingCheckout = { id: string; planType: StripePlanType; expiresAt: string };

export type BillingLock = {
  scope: BillingScope;
  associateCustomer(customerId: string): Promise<void>;
  savePendingCheckout(checkout: PendingCheckout): Promise<void>;
  clearPendingCheckout(): Promise<void>;
};

export interface StripeBillingStore {
  getScope(input: OwnedBillingScope): Promise<BillingScope>;
  getPublicStatus(input: OwnedBillingScope): Promise<PublicBillingStatus>;
  withBillingLock<T>(input: OwnedBillingScope, work: (lock: BillingLock) => Promise<T>): Promise<T>;
}

type BillingScopeRow = Omit<BillingScope,
  "trialEndsAt" | "currentPeriodEnd" | "subscriptionCanceledAt" | "checkoutExpiresAt"
> & {
  trialEndsAt: string | Date | null;
  currentPeriodEnd: string | Date | null;
  subscriptionCanceledAt: string | Date | null;
  checkoutExpiresAt: string | Date | null;
};

const scopeSql = `select owner_id as "userId", id as "restaurantId",
  plan_type as "planType", plan_status as "planStatus",
  stripe_customer_id as "stripeCustomerId", stripe_subscription_id as "stripeSubscriptionId",
  trial_ends_at as "trialEndsAt", stripe_current_period_end as "currentPeriodEnd",
  stripe_cancel_at_period_end as "cancelAtPeriodEnd",
  subscription_canceled_at as "subscriptionCanceledAt",
  stripe_checkout_session_id as "checkoutSessionId",
  stripe_checkout_plan_type as "checkoutPlanType", stripe_checkout_expires_at as "checkoutExpiresAt"
  from public.restaurants where id = $1::uuid and owner_id = $2::uuid`;

function nullableIso(value: string | Date | null): string | null {
  return value == null ? null : isoString(value);
}

function normalizeBillingStorageError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    throw new AppError(409, "billing_conflict", "Stripe resource is already associated");
  }
  throw new AppError(500, "internal_error", "Failed to persist Stripe billing state");
}

async function readBillingScope(database: Queryable, input: OwnedBillingScope, lock = false): Promise<BillingScope> {
  const result = await database.query<BillingScopeRow>(
    scopeSql + (lock ? " for update" : ""), [input.restaurantId, input.userId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(403, "forbidden", "Forbidden");
  return {
    ...row,
    trialEndsAt: nullableIso(row.trialEndsAt),
    currentPeriodEnd: nullableIso(row.currentPeriodEnd),
    subscriptionCanceledAt: nullableIso(row.subscriptionCanceledAt),
    checkoutExpiresAt: nullableIso(row.checkoutExpiresAt),
  };
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function updateOwnedRestaurant(
  database: Queryable,
  sql: string,
  values: unknown[],
): Promise<void> {
  try {
    const result = await database.query<{ id: string }>(sql, values);
    if (!result.rows[0]) {
      throw new AppError(403, "forbidden", "Forbidden");
    }
  } catch (error) {
    normalizeBillingStorageError(error);
  }
}

export function createStripeBillingRepository(database: Database): StripeBillingStore {
  return {
    async getScope(input) {
      try { return await readBillingScope(database, input); }
      catch (error) { normalizeBillingStorageError(error); }
    },

    async getPublicStatus(input) {
      try {
        const scope = await readBillingScope(database, input);
        return {
          planType: scope.planType, planStatus: scope.planStatus, trialEndsAt: scope.trialEndsAt,
          currentPeriodEnd: scope.currentPeriodEnd, cancelAtPeriodEnd: scope.cancelAtPeriodEnd,
          subscriptionCanceledAt: scope.subscriptionCanceledAt,
          canManageBilling: scope.stripeCustomerId !== null,
          requiresBillingAction: ["past_due", "incomplete", "unpaid", "paused"].includes(scope.planStatus),
        };
      } catch (error) { normalizeBillingStorageError(error); }
    },

    async withBillingLock(input, work) {
      try {
        return await withTransaction(database, async (client) => {
          const scope = await readBillingScope(client, input, true);
          return work({
            scope,
            async associateCustomer(customerId) {
              if (scope.stripeCustomerId && scope.stripeCustomerId !== customerId) {
                throw new AppError(409, "billing_conflict", "Customer is already associated");
              }
              await updateOwnedRestaurant(client, `update public.restaurants
                set stripe_customer_id = $3::text, updated_at = now()
                where id = $1::uuid and owner_id = $2::uuid
                  and (stripe_customer_id is null or stripe_customer_id = $3::text)
                returning id`, [input.restaurantId, input.userId, customerId]);
              scope.stripeCustomerId = customerId;
            },
            async savePendingCheckout(checkout) {
              await updateOwnedRestaurant(client, `update public.restaurants
                set stripe_checkout_session_id = $3::text, stripe_checkout_plan_type = $4::text,
                    stripe_checkout_expires_at = $5::timestamptz, updated_at = now()
                where id = $1::uuid and owner_id = $2::uuid returning id`,
                [input.restaurantId, input.userId, checkout.id, checkout.planType, checkout.expiresAt]);
              scope.checkoutSessionId = checkout.id;
              scope.checkoutPlanType = checkout.planType;
              scope.checkoutExpiresAt = checkout.expiresAt;
            },
            async clearPendingCheckout() {
              await updateOwnedRestaurant(client, `update public.restaurants
                set stripe_checkout_session_id = null, stripe_checkout_plan_type = null,
                    stripe_checkout_expires_at = null, updated_at = now()
                where id = $1::uuid and owner_id = $2::uuid returning id`,
                [input.restaurantId, input.userId]);
              scope.checkoutSessionId = null;
              scope.checkoutPlanType = null;
              scope.checkoutExpiresAt = null;
            },
          });
        });
      } catch (error) { normalizeBillingStorageError(error); }
    },
  };
}
