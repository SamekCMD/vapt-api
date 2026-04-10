import type { FastifyInstance } from "fastify";

import { AppError } from "../../../lib/errors.js";
import type { AppConfig } from "../../../lib/config.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createN8nClient } from "../../n8n/client.js";
import { createStripeBillingService } from "./service.js";

function requireString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function failInvalidRequest(): never {
  throw new AppError(400, "invalid_request", "Invalid request");
}

export async function registerStripeBillingRoutes(app: FastifyInstance, config: AppConfig) {
  const client = createN8nClient(config);
  const service = createStripeBillingService(client);

  app.post(
    "/billing/stripe/checkout",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const restaurantId = requireString(body?.restaurantId);
      const email = requireString(body?.email);
      const planType = requireString(body?.planType);
      const priceId = requireString(body?.priceId);

      if (!restaurantId || !email || !planType || !priceId) {
        failInvalidRequest();
      }

      return service.createCheckout({
        userId: request.auth!.userId,
        restaurantId,
        email,
        planType,
        priceId,
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/change",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const restaurantId = requireString(body?.restaurantId);
      const targetPlanType = requireString(body?.targetPlanType);
      const targetPriceId = requireString(body?.targetPriceId);

      if (!restaurantId || !targetPlanType || !targetPriceId) {
        failInvalidRequest();
      }

      return service.changeSubscription({
        userId: request.auth!.userId,
        restaurantId,
        targetPlanType,
        targetPriceId,
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/cancel",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const restaurantId = requireString(body?.restaurantId);

      if (!restaurantId) {
        failInvalidRequest();
      }

      return service.cancelSubscription({
        userId: request.auth!.userId,
        restaurantId,
      });
    },
  );

  app.get(
    "/billing/stripe/subscription",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const query = request.query as Record<string, unknown>;
      const restaurantId = requireString(query?.restaurantId);

      if (!restaurantId) {
        failInvalidRequest();
      }

      return service.getSubscriptionStatus({
        userId: request.auth!.userId,
        restaurantId,
      });
    },
  );
}
