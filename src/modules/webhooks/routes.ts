import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { createN8nClient } from "../n8n/client.js";
import { createWebhookRepository } from "./repository.js";
import { stripeWebhookHeadersSchema } from "./schemas.js";
import { createWebhookService } from "./service.js";

type WebhookRouteDeps = {
  service?: ReturnType<typeof createWebhookService>;
  database?: Queryable;
};

export async function registerWebhookRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: WebhookRouteDeps = {},
) {
  const service =
    deps.service ??
    createWebhookService(
      {
        stripeSigningSecret: config.stripe.webhookSecret,
        stripeToleranceSeconds: config.stripe.webhookToleranceSeconds,
      },
      createWebhookRepository(deps.database ?? (() => {
        throw new AppError(500, "internal_error", "Webhook database is not configured");
      })()),
      createN8nClient(config),
    );

  app.post(
    "/webhooks/stripe",
    {
      config: {
        rawBody: true,
        rateLimitGroup: "webhooks",
      },
    },
    async (request, reply) => {
      const headers = validateWithSchema(stripeWebhookHeadersSchema, request.headers);
      const response = await service.handleStripeWebhook({
        rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
        signatureHeader: headers["stripe-signature"],
        contentType: headers["content-type"],
      });

      reply.status(200).send(response);
    },
  );
}
