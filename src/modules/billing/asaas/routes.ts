import type { FastifyInstance } from "fastify";

import { AppError } from "../../../lib/errors.js";
import type { AppConfig } from "../../../lib/config.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createN8nClient } from "../../n8n/client.js";
import { createAsaasBillingService } from "./service.js";

function requireString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function failInvalidRequest(): never {
  throw new AppError(400, "invalid_request", "Invalid request");
}

export async function registerAsaasBillingRoutes(app: FastifyInstance, config: AppConfig) {
  const client = createN8nClient(config);
  const service = createAsaasBillingService(client);

  app.post(
    "/billing/asaas/setup",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const restaurantId = requireString(body?.restaurantId);
      const asaasApiKey = requireString(body?.asaasApiKey);
      const asaasEnvironment = requireString(body?.asaasEnvironment) as "production" | "sandbox";
      const asaasBillingDocument = requireString(body?.asaasBillingDocument);

      if (
        !restaurantId ||
        !asaasApiKey ||
        !asaasBillingDocument ||
        (asaasEnvironment !== "production" && asaasEnvironment !== "sandbox")
      ) {
        failInvalidRequest();
      }

      return service.setup({
        userId: request.auth!.userId,
        restaurantId,
        asaasApiKey,
        asaasEnvironment,
        asaasBillingDocument,
      });
    },
  );

  app.get(
    "/billing/asaas/setup/status",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const query = request.query as Record<string, unknown>;
      const restaurantId = requireString(query?.restaurantId);

      if (!restaurantId) {
        failInvalidRequest();
      }

      return service.getSetupStatus({
        userId: request.auth!.userId,
        restaurantId,
      });
    },
  );

  app.post(
    "/billing/asaas/pix",
    {
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const restaurantId = requireString(body?.restaurantId);
      const orderId = requireString(body?.orderId);
      const totalPrice = typeof body?.totalPrice === "number" ? body.totalPrice : NaN;

      if (!restaurantId || !orderId || Number.isNaN(totalPrice)) {
        failInvalidRequest();
      }

      return service.createPix({
        userId: request.auth!.userId,
        restaurantId,
        orderId,
        totalPrice,
      });
    },
  );
}
