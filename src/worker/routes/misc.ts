import type { Hono, MiddlewareHandler } from "hono";

import { actorFromAuth } from "../../plugins/auth.js";
import { restaurantParamsSchema } from "../../modules/restaurants/schemas.js";
import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireOrderToken } from "../../modules/feedback/token.js";
import { orderFeedbackBodySchema, pushSubscriptionBodySchema } from "../../modules/ingest/schemas.js";
import { validAdminSecret } from "../../modules/payments/effects-admin.js";
import { menuImageParamsSchema, prepareMenuImageUploadBodySchema } from "../../modules/storage/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { parseWorkerJson, requireWorkerAuth, workerRateLimit } from "../http.js";
import { isCatalogWriterEnabled, requireCatalogActor, prepareCatalogImage, retireCatalogImage, reconcileCatalogImages } from "../catalog/writer.js";

export function registerWorkerMiscRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const noRate: MiddlewareHandler<WorkerHonoEnv> = async (_context, next) => next();
  const storageRate = options.rateLimit === false ? noRate : workerRateLimit("storage");
  const billingRate = options.rateLimit === false ? noRate : workerRateLimit("billing");
  const authenticated: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    await requireWorkerAuth(context);
    await next();
  };
  const imageAuthenticated: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    if (isCatalogWriterEnabled(context.env)) await requireCatalogActor(context);
    else await requireWorkerAuth(context);
    await next();
  };
  const enabledStorage: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    if (!context.env.R2_BUCKET_NAME) {
      return context.json({ error: { code: "not_found", message: "Route not found" } }, 404);
    }
    await next();
  };

  app.post("/restaurants/:restaurantId/menu-images/reconcile", enabledStorage, storageRate, async (context) => {
    if (!isCatalogWriterEnabled(context.env)) return context.json({ error: { code: "not_found", message: "Route not found" } }, 404);
    return context.json(await reconcileCatalogImages(context));
  });
  app.post("/restaurants/:restaurantId/menu-items/:itemId/image/upload", enabledStorage, storageRate, imageAuthenticated, async (context) => {
    const params = validateWithSchema(menuImageParamsSchema, context.req.param());
    const body = validateWithSchema(prepareMenuImageUploadBodySchema, await parseWorkerJson(context.req.raw));
    if (isCatalogWriterEnabled(context.env)) return context.json(await prepareCatalogImage(context, params, body));
    const services = await context.get("getServices")();
    if (!services.menuImages) throw new AppError(503, "service_unavailable", "Service unavailable");
    return context.json(await services.menuImages.prepareUpload({
      ...actorFromAuth(context.get("auth")), ...params, ...body,
    }));
  });
  app.delete("/restaurants/:restaurantId/menu-items/:itemId/image", enabledStorage, storageRate, imageAuthenticated, async (context) => {
    const params = validateWithSchema(menuImageParamsSchema, context.req.param());
    if (isCatalogWriterEnabled(context.env)) {
      await retireCatalogImage(context, params);
      return context.body(null, 204);
    }
    const services = await context.get("getServices")();
    if (!services.menuImages) throw new AppError(503, "service_unavailable", "Service unavailable");
    await services.menuImages.delete({ ...actorFromAuth(context.get("auth")), ...params });
    return context.body(null, 204);
  });

  app.post("/ingest/order-feedback", billingRate, async (context) => {
    const body = validateWithSchema(orderFeedbackBodySchema, await parseWorkerJson(context.req.raw));
    const token = requireOrderToken(Object.fromEntries(context.req.raw.headers));
    const services = await context.get("getServices")();
    return context.json(await services.feedback.submitOrderFeedback(body.order_id, token, {
      rating: body.rating, reasons: body.reasons, comment: body.comment,
    }));
  });
  app.post("/ingest/push-subscription", billingRate, authenticated, async (context) => {
    const body = validateWithSchema(pushSubscriptionBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.pushSubscriptions.upsertOwnedSubscription(context.get("auth").userId, body,actorFromAuth(context.get("auth"))));
  });

  app.post('/restaurants/:restaurantId/push-subscription',billingRate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const body=validateWithSchema(pushSubscriptionBodySchema,await parseWorkerJson(context.req.raw));
    const services=await context.get('getServices')();
    return context.json(await services.pushSubscriptions.upsertSubscription({ ...actorFromAuth(context.get('auth')),restaurantId },body));
  });

  app.post("/admin/payments/effects/reprocess", billingRate, async (context) => {
    if (!validAdminSecret(context.req.header("x-vapt-admin-key"), context.env.PAYMENT_EFFECTS_ADMIN_SECRET)) {
      throw new AppError(401, "unauthorized", "Unauthorized");
    }
    const payload = await parseWorkerJson(context.req.raw) as { limit?: unknown } | null;
    const requestedLimit = payload?.limit;
    if (requestedLimit !== undefined &&
      (!Number.isInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 100)) {
      return context.json({
        error: { code: "invalid_request", message: "Limit must be an integer from 1 to 100" },
      }, 400);
    }
    const services = await context.get("getServices")();
    return context.json(await services.payments.reconciliation.runOnce(
      requestedLimit === undefined ? undefined : Number(requestedLimit),
    ));
  });
}
