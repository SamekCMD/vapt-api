import { AppError } from "../../../lib/errors.js";
import { createRestaurantAccessChecker } from "../../../lib/permissions.js";
import type {
  StripeBillingRepository,
  StripePlanStatus,
} from "./repository.js";

type StripeClient = {
  stripe: {
    createSubscription: (input: {
      restaurantId: string;
      email: string;
      planType: string;
      priceId: string;
    }) => Promise<{
      data: {
        clientSecret: string | null;
        subscriptionId: string | null;
        customerId: string | null;
        autoCharged: boolean;
      };
    }>;
    changeSubscription: (input: {
      restaurantId: string;
      targetPlanType: string;
      targetPriceId: string;
    }) => Promise<{
      data: {
        subscriptionId: string | null;
        plan_type: string;
        status: string;
        autoCharged: boolean;
      };
    }>;
    cancelSubscription: (input: {
      restaurantId: string;
    }) => Promise<{
      data: {
        subscriptionId: string | null;
        status: string;
      };
    }>;
    getSubscriptionStatus: (restaurantId: string) => Promise<{
      data: {
        plan_type: string | null;
        plan_status: string | null;
        trial_ends_at: string | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        billing_last_error?: string | null;
        subscription_canceled_at?: string | null;
      };
    }>;
  };
};

type OwnershipLookup = (input: { userId: string; restaurantId: string }) => Promise<boolean>;

const defaultOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

export function createStripeBillingService(
  client: StripeClient,
  ownershipLookup: OwnershipLookup = defaultOwnershipLookup,
  repository: StripeBillingRepository,
) {
  const assertRestaurantAccess = createRestaurantAccessChecker(ownershipLookup);

  return {
    async createCheckout(input: {
      userId: string;
      restaurantId: string;
      email: string;
      planType: string;
      priceId: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.createSubscription({
        restaurantId: input.restaurantId,
        email: input.email,
        planType: input.planType,
        priceId: input.priceId,
      });

      assertCheckoutResponse(response.data);
      await repository.persistCheckoutResult({
        userId: input.userId,
        restaurantId: input.restaurantId,
        stripeCustomerId: response.data.customerId,
        stripeSubscriptionId: response.data.subscriptionId,
        planType: input.planType,
        planStatus: response.data.autoCharged ? "active" : null,
      });

      return response.data;
    },

    async changeSubscription(input: {
      userId: string;
      restaurantId: string;
      targetPlanType: string;
      targetPriceId: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.changeSubscription({
        restaurantId: input.restaurantId,
        targetPlanType: input.targetPlanType,
        targetPriceId: input.targetPriceId,
      });

      assertChangeResponse(response.data);
      await repository.persistChangeResult({
        userId: input.userId,
        restaurantId: input.restaurantId,
        stripeSubscriptionId: response.data.subscriptionId,
        planType: response.data.plan_type,
        planStatus:
          normalizePlanStatus(response.data.status) ??
          (response.data.autoCharged ? "active" : null),
      });

      return {
        subscriptionId: response.data.subscriptionId,
        planType: response.data.plan_type,
        status: response.data.status,
        autoCharged: response.data.autoCharged,
      };
    },

    async cancelSubscription(input: {
      userId: string;
      restaurantId: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.cancelSubscription({
        restaurantId: input.restaurantId,
      });

      assertCancellationResponse(response.data);
      await repository.persistCancellationResult({
        userId: input.userId,
        restaurantId: input.restaurantId,
        stripeSubscriptionId: response.data.subscriptionId,
      });

      return response.data;
    },

    async getSubscriptionStatus(input: {
      userId: string;
      restaurantId: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.getSubscriptionStatus(input.restaurantId);

      assertStatusResponse(response.data);
      const planStatus = normalizePlanStatus(response.data.plan_status);
      await repository.persistStatusResult({
        userId: input.userId,
        restaurantId: input.restaurantId,
        planType: response.data.plan_type,
        planStatus,
        trialEndsAt: response.data.trial_ends_at,
        stripeCustomerId: response.data.stripe_customer_id,
        stripeSubscriptionId: response.data.stripe_subscription_id,
        billingLastError: response.data.billing_last_error ?? null,
        subscriptionCanceledAt: response.data.subscription_canceled_at ?? null,
      });

      return {
        planType: response.data.plan_type,
        planStatus,
        trialEndsAt: response.data.trial_ends_at,
        stripeCustomerId: response.data.stripe_customer_id,
        stripeSubscriptionId: response.data.stripe_subscription_id,
      };
    },
  };
}

function invalidUpstreamResponse(): never {
  throw new AppError(502, "invalid_upstream_response", "Stripe integration returned invalid data");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function assertCheckoutResponse(value: StripeClient["stripe"] extends {
  createSubscription: (...args: never[]) => Promise<{ data: infer T }>;
} ? T : never): void {
  if (
    !isNullableString(value.clientSecret) ||
    !isNullableString(value.subscriptionId) ||
    !isNullableString(value.customerId) ||
    typeof value.autoCharged !== "boolean"
  ) invalidUpstreamResponse();
}

function assertChangeResponse(value: {
  subscriptionId: unknown;
  plan_type: unknown;
  status: unknown;
  autoCharged: unknown;
}): void {
  if (
    !isNullableString(value.subscriptionId) ||
    typeof value.plan_type !== "string" ||
    value.plan_type.length === 0 ||
    typeof value.status !== "string" ||
    value.status.length === 0 ||
    typeof value.autoCharged !== "boolean"
  ) invalidUpstreamResponse();
}

function assertCancellationResponse(value: {
  subscriptionId: unknown;
  status: unknown;
}): void {
  if (
    !isNullableString(value.subscriptionId) ||
    (value.status !== "canceled" && value.status !== "cancelled")
  ) invalidUpstreamResponse();
}

function assertStatusResponse(value: {
  plan_type: unknown;
  plan_status: unknown;
  trial_ends_at: unknown;
  stripe_customer_id: unknown;
  stripe_subscription_id: unknown;
}): void {
  if (
    !isNullableString(value.plan_type) ||
    !isNullableString(value.plan_status) ||
    !isNullableString(value.trial_ends_at) ||
    !isNullableString(value.stripe_customer_id) ||
    !isNullableString(value.stripe_subscription_id)
  ) invalidUpstreamResponse();
  if (value.plan_status !== null && normalizePlanStatus(value.plan_status) === null) {
    invalidUpstreamResponse();
  }
}

function normalizePlanStatus(value: string | null): StripePlanStatus | null {
  if (value === "canceled" || value === "cancelled") return "cancelled";
  if (value === "trialing" || value === "active" || value === "expired") return value;
  return null;
}
