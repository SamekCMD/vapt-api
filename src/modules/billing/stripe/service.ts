import { AppError } from "../../../lib/errors.js";
import { createRestaurantAccessChecker } from "../../../lib/permissions.js";
import type {
  StripeBillingRepository,
  StripePlanStatus,
} from "./repository.js";
import type { StripePlanType } from "./schemas.js";

type StripePriceCatalog = Record<StripePlanType, string>;

type StripeClient = {
  stripe: {
    createSubscription: (input: {
      restaurantId: string;
      email: string;
      planType: StripePlanType;
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
      targetPlanType: StripePlanType;
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
  };
};

type OwnershipLookup = (input: { userId: string; restaurantId: string }) => Promise<boolean>;

const defaultOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

export function createStripeBillingService(
  client: StripeClient,
  ownershipLookup: OwnershipLookup = defaultOwnershipLookup,
  repository: StripeBillingRepository,
  priceCatalog: StripePriceCatalog,
) {
  const assertRestaurantAccess = createRestaurantAccessChecker(ownershipLookup);

  return {
    async createCheckout(input: {
      userId: string;
      restaurantId: string;
      email: string;
      planType: StripePlanType;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.createSubscription({
        restaurantId: input.restaurantId,
        email: input.email,
        planType: input.planType,
        priceId: priceCatalog[input.planType],
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
      targetPlanType: StripePlanType;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.stripe.changeSubscription({
        restaurantId: input.restaurantId,
        targetPlanType: input.targetPlanType,
        targetPriceId: priceCatalog[input.targetPlanType],
      });

      assertChangeResponse(response.data, input.targetPlanType);
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
      return repository.getStatus({
        userId: input.userId,
        restaurantId: input.restaurantId,
      });
    },
  };
}

function invalidUpstreamResponse(): never {
  throw new AppError(502, "invalid_upstream_response", "Stripe integration returned invalid data");
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStripePlanType(value: unknown): value is StripePlanType {
  return value === "starter" || value === "pro" || value === "business";
}

function assertCheckoutResponse(value: StripeClient["stripe"] extends {
  createSubscription: (...args: never[]) => Promise<{ data: infer T }>;
} ? T : never): void {
  if (
    !isNullableNonEmptyString(value.clientSecret) ||
    !isNonEmptyString(value.subscriptionId) ||
    !isNonEmptyString(value.customerId) ||
    typeof value.autoCharged !== "boolean" ||
    (!value.autoCharged && !isNonEmptyString(value.clientSecret))
  ) invalidUpstreamResponse();
}

function assertChangeResponse(value: {
  subscriptionId: unknown;
  plan_type: unknown;
  status: unknown;
  autoCharged: unknown;
}, expectedPlanType: StripePlanType): void {
  if (
    !isNonEmptyString(value.subscriptionId) ||
    !isStripePlanType(value.plan_type) ||
    value.plan_type !== expectedPlanType ||
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
    !isNonEmptyString(value.subscriptionId) ||
    (value.status !== "canceled" && value.status !== "cancelled")
  ) invalidUpstreamResponse();
}

function normalizePlanStatus(value: string | null): StripePlanStatus | null {
  if (value === "canceled" || value === "cancelled") return "cancelled";
  if (value === "trialing" || value === "active" || value === "expired") return value;
  return null;
}
