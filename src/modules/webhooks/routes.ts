import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { createN8nClient } from "../n8n/client.js";
import { createWebhookRepository } from "./repository.js";
import { createWebhookService } from "./service.js";

type WebhookRouteDeps = {
  service?: ReturnType<typeof createWebhookService>;
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
        stripeSigningSecret: config.webhooks.stripe.signingSecret,
        stripeToleranceSeconds: config.webhooks.stripe.toleranceSeconds,
      },
      createWebhookRepository(createSupabaseAdminClient(config)),
      createN8nClient(config),
    );

  app.post(
    "/webhooks/stripe",
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const response = await service.handleStripeWebhook({
        rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
        signatureHeader:
          typeof request.headers["stripe-signature"] === "string"
            ? request.headers["stripe-signature"]
            : undefined,
        contentType:
          typeof request.headers["content-type"] === "string"
            ? request.headers["content-type"]
            : undefined,
      });

      reply.status(200).send(response);
    },
  );

  app.post(
    "/webhooks/asaas",
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const response = await service.handleAsaasWebhook({
        rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
        accessToken:
          typeof request.headers["asaas-access-token"] === "string"
            ? request.headers["asaas-access-token"]
            : undefined,
        contentType:
          typeof request.headers["content-type"] === "string"
            ? request.headers["content-type"]
            : undefined,
      });

      reply.status(200).send(response);
    },
  );
}
