import type { Hono, MiddlewareHandler } from "hono";

import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { catalogParamsSchema } from "../../modules/catalog/schemas.js";
import { feedbackBodySchema, feedbackParamsSchema } from "../../modules/feedback/schemas.js";
import { requireOrderToken } from "../../modules/feedback/token.js";
import {
  createOrderBodySchema,
  createOrderHeadersSchema,
  publicOrderHeadersSchema,
  publicOrderParamsSchema,
} from "../../modules/orders/schemas.js";
import {
  requestCheckTableSessionBodySchema,
  tableSessionParamsSchema,
} from "../../modules/table-sessions/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { parseWorkerJson, workerRateLimit } from "../http.js";

export function registerWorkerPublicRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const noRate: MiddlewareHandler<WorkerHonoEnv> = async (_context, next) => next();
  const ordersRate = options.rateLimit === false ? noRate : workerRateLimit("orders");
  const publicRate = options.rateLimit === false ? noRate : workerRateLimit("public");

  app.get("/public/restaurants/:slug/catalog", publicRate, async (context) => {
    const params = validateWithSchema(catalogParamsSchema, context.req.param());
    const services = await context.get("getServices")();
    return context.json(await services.catalog.getPublishedCatalog(params.slug));
  });

  app.post("/public/orders", ordersRate, async (context) => {
    const body = validateWithSchema(createOrderBodySchema, await parseWorkerJson(context.req.raw));
    const headers = validateWithSchema(createOrderHeadersSchema,
      Object.fromEntries(context.req.raw.headers));
    const services = await context.get("getServices")();
    const order = await services.orders.createPublicOrder(body, headers["idempotency-key"]);
    return context.json(order, order.idempotentReplay ? 200 : 201);
  });

  app.get("/public/orders/:orderId", ordersRate, async (context) => {
    const params = validateWithSchema(publicOrderParamsSchema, context.req.param());
    const headers = validateWithSchema(publicOrderHeadersSchema,
      Object.fromEntries(context.req.raw.headers));
    const services = await context.get("getServices")();
    return context.json(await services.orders.getPublicOrder(params.orderId, headers["x-vapt-order-token"]));
  });

  app.put("/public/orders/:orderId/feedback", ordersRate, async (context) => {
    const params = validateWithSchema(feedbackParamsSchema, context.req.param());
    const body = validateWithSchema(feedbackBodySchema, await parseWorkerJson(context.req.raw));
    const token = requireOrderToken(Object.fromEntries(context.req.raw.headers));
    const services = await context.get("getServices")();
    return context.json(await services.feedback.submitOrderFeedback(params.orderId, token, body));
  });

  app.post("/public/table-sessions/:sessionId/request-check", ordersRate, async (context) => {
    const params = validateWithSchema(tableSessionParamsSchema, context.req.param());
    const body = validateWithSchema(requestCheckTableSessionBodySchema,
      await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    let order;
    try {
      order = await services.orders.getPublicOrder(body.publicOrderId, body.publicOrderToken);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        throw new AppError(401, "invalid_order_token", "Invalid order token");
      }
      throw error;
    }
    return context.json(await services.tableSessions.requestPublicCheck(params.sessionId, order));
  });
}
