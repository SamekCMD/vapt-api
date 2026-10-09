import type { Hono, MiddlewareHandler } from "hono";

import { validateWithSchema } from "../../lib/validation.js";
import { kitchenOrderParamsSchema, updateKitchenOrderStatusBodySchema } from "../../modules/kitchen/schemas.js";
import { createMenuItemBodySchema, menuItemParamsSchema, updateMenuItemBodySchema } from "../../modules/menu/schemas.js";
import { overviewQuerySchema } from "../../modules/overview/schemas.js";
import { onboardingBodySchema, updateOwnedRestaurantBodySchema } from "../../modules/restaurants/schemas.js";
import { tableSessionParamsSchema, transferTableSessionBodySchema } from "../../modules/table-sessions/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { parseWorkerJson, requireWorkerAuth, workerRateLimit } from "../http.js";

export function registerWorkerRestaurantRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const rate: MiddlewareHandler<WorkerHonoEnv> = options.rateLimit === false
    ? async (_context, next) => next()
    : workerRateLimit("auth");
  const authenticated: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    await requireWorkerAuth(context);
    await next();
  };

  app.post("/onboarding", rate, authenticated, async (context) => {
    const body = validateWithSchema(onboardingBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.restaurants.createOwnedRestaurant(context.get("auth").userId, body), 201);
  });
  app.get("/restaurants/me", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.restaurants.getOwnedRestaurant(context.get("auth").userId));
  });
  app.patch("/restaurants/me", rate, authenticated, async (context) => {
    const body = validateWithSchema(updateOwnedRestaurantBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.restaurants.updateOwnedRestaurant(context.get("auth").userId, body));
  });

  app.get("/restaurants/me/menu-items", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.menu.listOwnedMenuItems(context.get("auth").userId));
  });
  app.post("/restaurants/me/menu-items", rate, authenticated, async (context) => {
    const body = validateWithSchema(createMenuItemBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.menu.createOwnedMenuItem(context.get("auth").userId, body), 201);
  });
  app.patch("/restaurants/me/menu-items/:itemId", rate, authenticated, async (context) => {
    const params = validateWithSchema(menuItemParamsSchema, context.req.param());
    const body = validateWithSchema(updateMenuItemBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.menu.updateOwnedMenuItem(context.get("auth").userId, params.itemId, body));
  });
  app.delete("/restaurants/me/menu-items/:itemId", rate, authenticated, async (context) => {
    const params = validateWithSchema(menuItemParamsSchema, context.req.param());
    const services = await context.get("getServices")();
    await services.menu.deleteOwnedMenuItem(context.get("auth").userId, params.itemId);
    return context.body(null, 204);
  });

  app.get("/restaurants/me/kitchen/orders", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.kitchen.listActiveOwnedOrders(context.get("auth").userId));
  });
  app.patch("/restaurants/me/kitchen/orders/:orderId/status", rate, authenticated, async (context) => {
    const params = validateWithSchema(kitchenOrderParamsSchema, context.req.param());
    const body = validateWithSchema(updateKitchenOrderStatusBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.kitchen.updateOwnedOrderStatus(context.get("auth").userId, params.orderId, body.status));
  });
  app.get("/restaurants/me/overview", rate, authenticated, async (context) => {
    const query = validateWithSchema(overviewQuerySchema, context.req.query());
    const services = await context.get("getServices")();
    return context.json(await services.overview.getOwnedOverview(context.get("auth").userId, query.period));
  });

  app.get("/restaurants/me/table-sessions", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.tableSessions.listActiveOwnedSessions(context.get("auth").userId));
  });
  app.get("/restaurants/me/table-sessions/:sessionId", rate, authenticated, async (context) => {
    const params = validateWithSchema(tableSessionParamsSchema, context.req.param());
    const services = await context.get("getServices")();
    return context.json(await services.tableSessions.getOwnedSession(context.get("auth").userId, params.sessionId));
  });
  app.post("/restaurants/me/table-sessions/:sessionId/close", rate, authenticated, async (context) => {
    const params = validateWithSchema(tableSessionParamsSchema, context.req.param());
    const services = await context.get("getServices")();
    return context.json(await services.tableSessions.closeOwnedSession(context.get("auth").userId, params.sessionId));
  });
  app.post("/restaurants/me/table-sessions/:sessionId/transfer", rate, authenticated, async (context) => {
    const params = validateWithSchema(tableSessionParamsSchema, context.req.param());
    const body = validateWithSchema(transferTableSessionBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.tableSessions.transferOwnedSession(
      context.get("auth").userId, params.sessionId, body.tableNumber,
    ));
  });
}
