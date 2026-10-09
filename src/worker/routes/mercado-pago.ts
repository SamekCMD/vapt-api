import type { Hono, MiddlewareHandler } from "hono";

import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import {
  callbackQuerySchema,
  connectBodySchema,
  createMercadoPagoOAuthRedirect,
  environmentQuerySchema,
  resolveReturnOrigin,
  restaurantParamsSchema,
} from "../../modules/payments/providers/mercado-pago/http-contract.js";
import { verifyMercadoPagoWebhookSignature } from "../../modules/payments/providers/mercado-pago/webhook.js";
import { createMercadoPagoBrowserReturnUrl, createMercadoPagoReturnUrls, queryStringValue } from "../../modules/payments/return-urls.js";
import {
  hostedCheckoutBodySchema,
  hostedCheckoutHeadersSchema,
  hostedCheckoutParamsSchema,
  manualPaymentBodySchema,
  manualPaymentHeadersSchema,
  manualPaymentParamsSchema,
  paymentDiagnosticsHeadersSchema,
  paymentDiagnosticsParamsSchema,
} from "../../modules/payments/schemas.js";
import { createHostedCheckoutService } from "../../modules/payments/service.js";
import type { WorkerHonoEnv } from "../app.js";
import { parseWorkerJson, readWorkerBody, requireWorkerAuth, workerRateLimit } from "../http.js";

export function registerWorkerMercadoPagoRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const rate: MiddlewareHandler<WorkerHonoEnv> = options.rateLimit === false
    ? async (_context, next) => next()
    : workerRateLimit("billing");
  const authenticated: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    await requireWorkerAuth(context);
    await next();
  };
  const enabled: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    if (!context.env.MERCADO_PAGO_CLIENT_ID) {
      return context.json({ error: { code: "not_found", message: "Route not found" } }, 404);
    }
    await next();
  };
  const marketplace = async (context: Parameters<MiddlewareHandler<WorkerHonoEnv>>[0]) => {
    const services = await context.get("getServices")();
    if (!services.mercadoPago || !services.config.mercadoPago) {
      throw new AppError(503, "mercado_pago_not_configured", "Mercado Pago is not configured");
    }
    return { services, mercadoPago: services.mercadoPago, config: services.config };
  };

  app.post("/orders/:orderId/payments/manual-confirmation", rate, authenticated, async (context) => {
    const params = validateWithSchema(manualPaymentParamsSchema, context.req.param());
    const headers = validateWithSchema(manualPaymentHeadersSchema,
      Object.fromEntries(context.req.raw.headers));
    const body = validateWithSchema(manualPaymentBodySchema, await parseWorkerJson(context.req.raw));
    const auth = context.get("auth");
    const services = await context.get("getServices")();
    const transaction = await services.manualPayments.confirm({
      orderId: params.orderId,
      paymentMethod: body.paymentMethod,
      idempotencyKey: headers["idempotency-key"],
      userId: auth.userId,
      authRole: auth.role,
    });
    return context.json({
      transactionId: transaction.id,
      orderId: transaction.orderId,
      status: transaction.status,
      amount: transaction.amount,
      paymentMethod: transaction.paymentMethod,
      confirmedAt: transaction.updatedAt,
    });
  });

  app.post("/public/orders/:orderId/payments/checkout", enabled, rate, async (context) => {
    const params = validateWithSchema(hostedCheckoutParamsSchema, context.req.param());
    const headers = validateWithSchema(hostedCheckoutHeadersSchema,
      Object.fromEntries(context.req.raw.headers));
    const body = validateWithSchema(hostedCheckoutBodySchema,
      await parseWorkerJson(context.req.raw));
    const { services, config } = await marketplace(context);
    const service = createHostedCheckoutService({
      orderService: services.orders,
      paymentService: services.payments.service,
      environment: config.mercadoPago!.environment,
      returnUrls: createMercadoPagoReturnUrls(config, body.returnOrigin),
    });
    const transaction = await service.start({
      orderId: params.orderId,
      publicOrderToken: headers["x-vapt-order-token"],
      idempotencyKey: headers["idempotency-key"],
    });
    return context.json({
      transactionId: transaction.id,
      orderId: transaction.orderId,
      status: transaction.status,
      amount: transaction.amount,
      checkoutUrl: transaction.checkoutUrl,
      expiresAt: transaction.expiresAt,
      ...(config.mercadoPago?.environment === "sandbox"
        ? { diagnostics: transaction.providerPayload.checkoutDiagnostics ?? null } : {}),
    });
  });

  app.get("/public/orders/:orderId/payments/:transactionId/diagnostics", enabled, rate, async (context) => {
    if (context.env.MERCADO_PAGO_ENVIRONMENT !== "sandbox") {
      return context.json({ error: { code: "not_found", message: "Route not found" } }, 404);
    }
    const params = validateWithSchema(paymentDiagnosticsParamsSchema, context.req.param());
    const headers = validateWithSchema(paymentDiagnosticsHeadersSchema,
      Object.fromEntries(context.req.raw.headers));
    const { mercadoPago } = await marketplace(context);
    return context.json(await mercadoPago.diagnostics.inspect({
      orderId: params.orderId,
      transactionId: params.transactionId,
      publicOrderToken: headers["x-vapt-order-token"],
    }));
  });

  app.post("/restaurants/:restaurantId/payments/mercado-pago/connect", enabled, rate, authenticated, async (context) => {
    const params = validateWithSchema(restaurantParamsSchema, context.req.param());
    const body = validateWithSchema(connectBodySchema, await parseWorkerJson(context.req.raw));
    const { mercadoPago, config } = await marketplace(context);
    return context.json(await mercadoPago.oauth.beginConnection({
      restaurantId: params.restaurantId,
      userId: context.get("auth").userId,
      environment: body.environment,
      returnOrigin: resolveReturnOrigin(body.returnOrigin, config),
    }));
  });

  app.get("/payments/mercado-pago/oauth/callback", enabled, rate, async (context) => {
    const query = validateWithSchema(callbackQuerySchema, context.req.query());
    const { mercadoPago, config } = await marketplace(context);
    const result = await mercadoPago.oauth.handleCallback({
      state: query.state, code: query.code, error: query.error,
      errorDescription: query.error_description,
    });
    return context.redirect(createMercadoPagoOAuthRedirect(config, result.status, result.returnOrigin).toString());
  });

  app.get("/restaurants/:restaurantId/payments/mercado-pago/status", enabled, rate, authenticated, async (context) => {
    const params = validateWithSchema(restaurantParamsSchema, context.req.param());
    const query = validateWithSchema(environmentQuerySchema, context.req.query());
    const { mercadoPago } = await marketplace(context);
    return context.json(await mercadoPago.oauth.getStatus({
      restaurantId: params.restaurantId, userId: context.get("auth").userId,
      environment: query.environment,
    }));
  });

  app.delete("/restaurants/:restaurantId/payments/mercado-pago/connection", enabled, rate, authenticated, async (context) => {
    const params = validateWithSchema(restaurantParamsSchema, context.req.param());
    const query = validateWithSchema(environmentQuerySchema, context.req.query());
    const { mercadoPago } = await marketplace(context);
    return context.json(await mercadoPago.oauth.disconnect({
      restaurantId: params.restaurantId, userId: context.get("auth").userId,
      environment: query.environment,
    }));
  });

  app.get("/payments/mercado-pago/return", enabled, async (context) => {
    const query: Record<string, unknown> = context.req.query();
    const requestedResult = queryStringValue(query.result);
    let result: "success" | "pending" | "failure" = requestedResult === "success" || requestedResult === "pending"
      ? requestedResult : "failure";
    const paymentId = queryStringValue(query.payment_id);
    const externalReference = queryStringValue(query.external_reference);
    const { mercadoPago, config } = await marketplace(context);
    if (paymentId && externalReference) {
      try {
        const transaction = await mercadoPago.returnReconciliation.reconcile({
          transactionId: externalReference, paymentId,
        });
        result = transaction.status === "paid" ? "success"
          : transaction.status === "pending" || transaction.status === "processing" ? "pending" : "failure";
      } catch {
        result = "pending";
      }
    }
    return context.redirect(createMercadoPagoBrowserReturnUrl(config, query, result).toString());
  });

  const webhookRate = options.rateLimit === false
    ? async (_context: Parameters<MiddlewareHandler<WorkerHonoEnv>>[0], next: Parameters<MiddlewareHandler<WorkerHonoEnv>>[1]) => next()
    : workerRateLimit("webhooks");
  const webhook = async (context: Parameters<MiddlewareHandler<WorkerHonoEnv>>[0]) => {
    const dataId = context.req.query("data.id")?.trim() || context.req.query("data_id")?.trim();
    const requestId = context.req.header("x-request-id")?.trim();
    const signatureHeader = context.req.header("x-signature")?.trim();
    if (!dataId) throw new AppError(400, "invalid_request", "Mercado Pago data.id is required");
    if (!requestId || !signatureHeader) {
      throw new AppError(401, "invalid_webhook_signature", "Invalid Mercado Pago webhook signature");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) {
      throw new AppError(400, "invalid_request", "Invalid Mercado Pago webhook payload");
    }
    const rawBody = await readWorkerBody(context.req.raw);
    const { mercadoPago, config } = await marketplace(context);
    if (!verifyMercadoPagoWebhookSignature({
      dataId, requestId, signatureHeader, secret: config.mercadoPago!.webhookSecret,
    })) {
      throw new AppError(401, "invalid_webhook_signature", "Invalid Mercado Pago webhook signature");
    }
    return context.json(await mercadoPago.webhook.handle({ rawBody, dataId, requestId, signatureHeader }));
  };
  app.post("/webhooks/payments/mercado-pago", enabled, webhookRate, webhook);
  app.post("/payments/mercado-pago/webhook", enabled, webhookRate, webhook);
}
