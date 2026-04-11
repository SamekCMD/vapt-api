import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../../lib/config.js";
import { validateWithSchema } from "../../../lib/validation.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createN8nClient } from "../../n8n/client.js";
import {
  asaasPixBodySchema,
  asaasSetupBodySchema,
  asaasSetupStatusQuerySchema,
} from "./schemas.js";
import { createAsaasBillingService } from "./service.js";

export async function registerAsaasBillingRoutes(app: FastifyInstance, config: AppConfig) {
  const client = createN8nClient(config);
  const service = createAsaasBillingService(client);

  app.post(
    "/billing/asaas/setup",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(asaasSetupBodySchema, request.body);

      return service.setup({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        asaasApiKey: body.asaasApiKey,
        asaasEnvironment: body.asaasEnvironment,
        asaasBillingDocument: body.asaasBillingDocument,
      });
    },
  );

  app.get(
    "/billing/asaas/setup/status",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const query = validateWithSchema(asaasSetupStatusQuerySchema, request.query);

      return service.getSetupStatus({
        userId: request.auth!.userId,
        restaurantId: query.restaurantId,
      });
    },
  );

  app.post(
    "/billing/asaas/pix",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(asaasPixBodySchema, request.body);

      return service.createPix({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        orderId: body.orderId,
        totalPrice: body.totalPrice,
      });
    },
  );
}
