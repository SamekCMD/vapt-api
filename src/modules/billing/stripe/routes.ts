import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../../lib/config.js";
import {
  createSupabaseMembershipLookup,
  testMembershipLookup,
  type MembershipLookup,
} from "../../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../../lib/supabase.js";
import { validateWithSchema } from "../../../lib/validation.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createN8nClient } from "../../n8n/client.js";
import {
  stripeCancelSubscriptionBodySchema,
  stripeChangeSubscriptionBodySchema,
  stripeCheckoutBodySchema,
  stripeSubscriptionStatusQuerySchema,
} from "./schemas.js";
import { createStripeBillingService } from "./service.js";

export async function registerStripeBillingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  membershipLookup?: MembershipLookup,
) {
  const resolvedMembershipLookup =
    membershipLookup ??
    (config.nodeEnv === "test"
      ? testMembershipLookup
      : createSupabaseMembershipLookup(createSupabaseAdminClient(config) as never));
  const client = createN8nClient(config);
  const service = createStripeBillingService(client, resolvedMembershipLookup);

  app.post(
    "/billing/stripe/checkout",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(stripeCheckoutBodySchema, request.body);

      return service.createCheckout({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        email: body.email,
        planType: body.planType,
        priceId: body.priceId,
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/change",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(stripeChangeSubscriptionBodySchema, request.body);

      return service.changeSubscription({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        targetPlanType: body.targetPlanType,
        targetPriceId: body.targetPriceId,
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/cancel",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(stripeCancelSubscriptionBodySchema, request.body);

      return service.cancelSubscription({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
      });
    },
  );

  app.get(
    "/billing/stripe/subscription",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const query = validateWithSchema(stripeSubscriptionStatusQuerySchema, request.query);

      return service.getSubscriptionStatus({
        userId: request.auth!.userId,
        restaurantId: query.restaurantId,
      });
    },
  );
}
