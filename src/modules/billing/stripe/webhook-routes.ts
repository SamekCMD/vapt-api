import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import { constructStripeWebhookEvent, createStripeClient } from "./client.js";
import type { createStripeWebhookService } from "./webhook-service.js";

export async function registerStripeWebhookRoutes(app: FastifyInstance, config: Pick<AppConfig, "stripe">,
  dependencies: { service: Pick<ReturnType<typeof createStripeWebhookService>, "handleEvent">;
    constructEvent?: (rawBody: string, signature: string) => Promise<unknown> }) {
  const client = dependencies.constructEvent ? null : createStripeClient(config.stripe);
  const constructEvent = dependencies.constructEvent ?? ((raw, signature) =>
    constructStripeWebhookEvent(client!, raw, signature, config.stripe));
  app.post("/webhooks/stripe", {
    config: { rawBody: true, rateLimitGroup: "webhooks" },
    errorHandler(error, _request, reply) {
      if (error instanceof AppError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      const invalidBody = error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY";
      return reply.status(invalidBody ? 400 : 500).send({ error: {
        code: invalidBody ? "invalid_webhook_body" : "billing_processing_failed",
        message: invalidBody ? "Invalid billing event body" : "Billing event will be retried",
      } });
    },
  }, async request => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature) throw new AppError(401, "invalid_webhook_signature", "Invalid billing event signature");
    if (typeof request.rawBody !== "string" || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      throw new AppError(400, "invalid_webhook_body", "Invalid billing event body");
    }
    let event: unknown;
    try { event = await constructEvent(request.rawBody, signature); }
    catch { throw new AppError(401, "invalid_webhook_signature", "Invalid billing event signature"); }
    return dependencies.service.handleEvent(event);
  });
}
