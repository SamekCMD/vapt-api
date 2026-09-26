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

export type PersistStatusResultInput = OwnedBillingScope & {
  planType: string | null;
  planStatus: StripePlanStatus | null;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingLastError: string | null;
  subscriptionCanceledAt: string | null;
};

export interface StripeBillingRepository {
  persistCheckoutResult(input: PersistCheckoutResultInput): Promise<void>;
  persistChangeResult(input: PersistChangeResultInput): Promise<void>;
  persistCancellationResult(input: PersistCancellationResultInput): Promise<void>;
  persistStatusResult(input: PersistStatusResultInput): Promise<void>;
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

    async persistStatusResult(input) {
      await updateOwnedRestaurant(
        database,
        `update public.restaurants
        set plan_type = coalesce($3::text, plan_type),
            plan_status = coalesce($4::text, plan_status),
            trial_ends_at = $5::timestamptz,
            stripe_customer_id = $6::text,
            stripe_subscription_id = $7::text,
            billing_last_error = $8::text,
            subscription_canceled_at = $9::timestamptz,
            updated_at = now()
        where id = $1::uuid
          and owner_id = $2::uuid
        returning id`,
        [
          input.restaurantId,
          input.userId,
          input.planType,
          input.planStatus,
          input.trialEndsAt,
          input.stripeCustomerId,
          input.stripeSubscriptionId,
          input.billingLastError,
          input.subscriptionCanceledAt,
        ],
      );
    },
  };
}
