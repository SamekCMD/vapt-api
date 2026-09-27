import type { Queryable } from "../../../lib/database.js";
import { AppError } from "../../../lib/errors.js";

export type StripePlanStatus = "trialing" | "active" | "expired" | "cancelled";

type OwnedBillingScope = {
  userId: string;
  restaurantId: string;
};

export type PersistCheckoutResultInput = OwnedBillingScope & {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planType: string;
  planStatus: StripePlanStatus | null;
};

export type PersistChangeResultInput = OwnedBillingScope & {
  stripeSubscriptionId: string | null;
  planType: string;
  planStatus: StripePlanStatus | null;
};

export type PersistCancellationResultInput = OwnedBillingScope & {
  stripeSubscriptionId: string | null;
};

export type StripeBillingStatus = {
  planType: string | null;
  planStatus: StripePlanStatus | null;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingLastError: string | null;
  subscriptionCanceledAt: string | null;
};

type StripeBillingStatusRow = Omit<
  StripeBillingStatus,
  "trialEndsAt" | "subscriptionCanceledAt"
> & {
  trialEndsAt: string | Date | null;
  subscriptionCanceledAt: string | Date | null;
};

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface StripeBillingRepository {
  persistCheckoutResult(input: PersistCheckoutResultInput): Promise<void>;
  persistChangeResult(input: PersistChangeResultInput): Promise<void>;
  persistCancellationResult(input: PersistCancellationResultInput): Promise<void>;
  getStatus(input: OwnedBillingScope): Promise<StripeBillingStatus>;
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
    if (error instanceof AppError) throw error;
    throw new AppError(500, "internal_error", "Failed to persist Stripe billing state");
  }
}

export function createStripeBillingRepository(database: Queryable): StripeBillingRepository {
  return {
    async persistCheckoutResult(input) {
      await updateOwnedRestaurant(
        database,
        `update public.restaurants
        set stripe_customer_id = coalesce($3::text, stripe_customer_id),
            stripe_subscription_id = coalesce($4::text, stripe_subscription_id),
            plan_type = $5::text,
            plan_status = coalesce($6::text, plan_status),
            subscription_canceled_at = null,
            billing_last_error = null,
            updated_at = now()
        where id = $1::uuid
          and owner_id = $2::uuid
        returning id`,
        [
          input.restaurantId,
          input.userId,
          input.stripeCustomerId,
          input.stripeSubscriptionId,
          input.planType,
          input.planStatus,
        ],
      );
    },

    async persistChangeResult(input) {
      await updateOwnedRestaurant(
        database,
        `update public.restaurants
        set stripe_subscription_id = coalesce($3::text, stripe_subscription_id),
            plan_type = $4::text,
            plan_status = coalesce($5::text, plan_status),
            subscription_canceled_at = null,
            billing_last_error = null,
            updated_at = now()
        where id = $1::uuid
          and owner_id = $2::uuid
        returning id`,
        [
          input.restaurantId,
          input.userId,
          input.stripeSubscriptionId,
          input.planType,
          input.planStatus,
        ],
      );
    },

    async persistCancellationResult(input) {
      await updateOwnedRestaurant(
        database,
        `update public.restaurants
        set stripe_subscription_id = coalesce($3::text, stripe_subscription_id),
            plan_status = 'cancelled',
            subscription_canceled_at = now(),
            billing_last_error = null,
            updated_at = now()
        where id = $1::uuid
          and owner_id = $2::uuid
        returning id`,
        [input.restaurantId, input.userId, input.stripeSubscriptionId],
      );
    },

    async getStatus(input) {
      try {
        const result = await database.query<StripeBillingStatusRow>(
          `select plan_type as "planType",
                  plan_status as "planStatus",
                  trial_ends_at as "trialEndsAt",
                  stripe_customer_id as "stripeCustomerId",
                  stripe_subscription_id as "stripeSubscriptionId",
                  billing_last_error as "billingLastError",
                  subscription_canceled_at as "subscriptionCanceledAt"
          from public.restaurants
          where id = $1::uuid
            and owner_id = $2::uuid`,
          [input.restaurantId, input.userId],
        );
        const row = result.rows[0];
        if (!row) throw new AppError(403, "forbidden", "Forbidden");
        return {
          ...row,
          trialEndsAt: row.trialEndsAt === null ? null : isoString(row.trialEndsAt),
          subscriptionCanceledAt:
            row.subscriptionCanceledAt === null
              ? null
              : isoString(row.subscriptionCanceledAt),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(500, "internal_error", "Failed to read Stripe billing state");
      }
    },
  };
}
