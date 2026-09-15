import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { validateWithSchema } from "../../lib/validation.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { createN8nClient } from "../n8n/client.js";
import { createWebhookRepository } from "./repository.js";
import { stripeWebhookHeadersSchema } from "./schemas.js";
import { createWebhookService } from "./service.js";

type WebhookRouteDeps = {
  service?: ReturnType<typeof createWebhookService>;
};

export async function registerWebhookRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: WebhookRouteDeps = {},
) {
  const stripeConfig = config.webhooks.stripe;
  if (!deps.service && !stripeConfig) {
    throw new Error("Stripe webhook is not configured");
  }

  const service =
    deps.service ??
    createWebhookService(
      {
        stripeSigningSecret: stripeConfig!.signingSecret,
        stripeToleranceSeconds: stripeConfig!.toleranceSeconds,
      },
      createWebhookRepository(createSupabaseAdminClient(config)),
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
