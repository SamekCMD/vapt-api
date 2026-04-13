import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import { createN8nClient } from "../n8n/client.js";
import { orderFeedbackBodySchema, pushSubscriptionBodySchema } from "./schemas.js";

export async function registerIngestRoutes(app: FastifyInstance, config: AppConfig) {
  const client = createN8nClient(config);

  app.post(
    "/ingest/order-feedback",
    {
      config: {
        rateLimitGroup: "billing",
      },
    },
    async (request) => {
      const body = validateWithSchema(orderFeedbackBodySchema, request.body);
      const response = await client.call("ingest.orderFeedback", { body });
      return response.data;
    },
  );

  app.post(
    "/ingest/push-subscription",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(pushSubscriptionBodySchema, request.body);
      const response = await client.call("ingest.pushSubscription", { body });
      return response.data;
    },
  );
}
