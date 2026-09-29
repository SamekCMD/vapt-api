import type { Hono, MiddlewareHandler } from "hono";

import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { constructStripeWebhookEvent, createStripeClient } from "../../modules/billing/stripe/client.js";
import {
  stripeCheckoutBodySchema,
  stripePortalBodySchema,
  stripeSubscriptionStatusQuerySchema,
} from "../../modules/billing/stripe/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { parseWorkerJson, requireWorkerAuth, workerRateLimit } from "../http.js";

export function registerWorkerStripeRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const noRate: MiddlewareHandler<WorkerHonoEnv> = async (_context, next) => next();
  const billingRate = options.rateLimit === false ? noRate : workerRateLimit("billing");
  const webhookRate = options.rateLimit === false ? noRate : workerRateLimit("webhooks");
  const authenticated: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    await requireWorkerAuth(context);
    await next();
  };

  app.post("/billing/stripe/checkout", billingRate, authenticated, async (context) => {
    const body = validateWithSchema(stripeCheckoutBodySchema, await parseWorkerJson(context.req.raw));
    const auth = context.get("auth");
    if (!auth.email) throw new AppError(400, "invalid_request", "Authenticated email is required");
    const services = await context.get("getServices")();
    return context.json(await services.stripeBilling.createCheckout({
      userId: auth.userId,
      restaurantId: body.restaurantId,
      email: auth.email,
      planType: body.planType,
      idempotencyKey: context.req.header("idempotency-key") ?? "",
    }));
  });

  app.post("/billing/stripe/portal", billingRate, authenticated, async (context) => {
    const body = validateWithSchema(stripePortalBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.stripeBilling.createPortal({
      userId: context.get("auth").userId, restaurantId: body.restaurantId,
    }));
  });

  app.get("/billing/stripe/subscription", billingRate, authenticated, async (context) => {
    const query = validateWithSchema(stripeSubscriptionStatusQuerySchema, context.req.query());
    const services = await context.get("getServices")();
    return context.json(await services.stripeBilling.getSubscriptionStatus({
      userId: context.get("auth").userId, restaurantId: query.restaurantId,
    }));
  });

  app.post("/webhooks/stripe", webhookRate, async (context) => {
    const signature = context.req.header("stripe-signature");
    if (!signature) throw new AppError(401, "invalid_webhook_signature", "Invalid billing event signature");
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) {
      throw new AppError(400, "invalid_webhook_body", "Invalid billing event body");
    }
    const rawBody = await context.req.raw.text();
    if (!rawBody) throw new AppError(400, "invalid_webhook_body", "Invalid billing event body");
    const services = await context.get("getServices")();
    let event: unknown;
    try {
      event = await constructStripeWebhookEvent(
        createStripeClient(services.config.stripe), rawBody, signature, services.config.stripe,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new AppError(400, "invalid_webhook_body", "Invalid billing event body");
      }
      throw new AppError(401, "invalid_webhook_signature", "Invalid billing event signature");
    }
    try {
      return context.json(await services.stripeWebhooks.handleEvent(event));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, "billing_processing_failed", "Billing event will be retried");
    }
  });
}
