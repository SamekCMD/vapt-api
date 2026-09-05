import { AppError } from "../../../lib/errors.js";
import {
  createRestaurantAccessChecker,
  type MembershipLookup,
} from "../../../lib/permissions.js";

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
      };
    }>;
  };
};

export function createStripeBillingService(
  client: StripeClient,
  membershipLookup: MembershipLookup,
) {
  const assertRestaurantAccess = createRestaurantAccessChecker(membershipLookup);

  return {
    async createCheckout(input: {
      userId: string;
      restaurantId: string;
      email: string;
      planType: string;
      priceId: string;
    }) {
      await assertRestaurantAccess({
        userId: input.userId,
        restaurantId: input.restaurantId,
        capability: "billing.manage",
      });

      const response = await client.stripe.createSubscription({
        restaurantId: input.restaurantId,
        email: input.email,
        planType: input.planType,
        priceId: input.priceId,
      });

      return response.data;
    },

    async changeSubscription(input: {
      userId: string;
      restaurantId: string;
      targetPlanType: string;
      targetPriceId: string;
    }) {
      await assertRestaurantAccess({
        userId: input.userId,
        restaurantId: input.restaurantId,
        capability: "billing.manage",
      });

      const response = await client.stripe.changeSubscription({
        restaurantId: input.restaurantId,
        targetPlanType: input.targetPlanType,
        targetPriceId: input.targetPriceId,
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
      await assertRestaurantAccess({
        userId: input.userId,
        restaurantId: input.restaurantId,
        capability: "billing.manage",
      });

      const response = await client.stripe.cancelSubscription({
        restaurantId: input.restaurantId,
      });

      return response.data;
    },

    async getSubscriptionStatus(input: {
      userId: string;
      restaurantId: string;
    }) {
      await assertRestaurantAccess({
        userId: input.userId,
        restaurantId: input.restaurantId,
        capability: "billing.read",
      });

      const response = await client.stripe.getSubscriptionStatus(input.restaurantId);

      return {
        planType: response.data.plan_type,
        planStatus: response.data.plan_status,
        trialEndsAt: response.data.trial_ends_at,
        stripeCustomerId: response.data.stripe_customer_id,
        stripeSubscriptionId: response.data.stripe_subscription_id,
      };
    },
  };
}
