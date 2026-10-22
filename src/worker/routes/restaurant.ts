import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { actorFromAuth } from '../../plugins/auth.js';
import { affectsPublicCatalog } from "../../modules/catalog-publication/policy.js";
import { legacyCatalogRestaurant, catalogOperationId, controlCatalogOperation, isCatalogWriterEnabled, requireCatalogActor, respondCatalogMutation, submitCatalogMutation } from "../catalog/writer.js";

import { validateWithSchema } from "../../lib/validation.js";
import { kitchenOrderParamsSchema, scopedKitchenOrderParamsSchema, updateKitchenOrderStatusBodySchema } from "../../modules/kitchen/schemas.js";
import { createMenuItemBodySchema, menuItemParamsSchema, restaurantMenuParamsSchema, restaurantMenuItemParamsSchema, updateMenuItemBodySchema } from "../../modules/menu/schemas.js";
import { overviewQuerySchema } from "../../modules/overview/schemas.js";
import { onboardingBodySchema, slugAvailabilityQuerySchema,restaurantParamsSchema, updateOwnedRestaurantBodySchema } from "../../modules/restaurants/schemas.js";
import { tableSessionParamsSchema, scopedTableSessionParamsSchema, transferTableSessionBodySchema } from "../../modules/table-sessions/schemas.js";
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
    if (isCatalogWriterEnabled(context.env)) await requireCatalogActor(context);
    else await requireWorkerAuth(context);
    await next();
  };

  app.post("/onboarding", rate, authenticated, async (context) => {
    const body = validateWithSchema(onboardingBodySchema, await parseWorkerJson(context.req.raw));
    throw new AppError(410,'legacy_onboarding_retired','Use account onboarding drafts and explicit finalization');
  });
  app.get("/restaurants/me", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.restaurants.getOwnedRestaurant(context.get("auth").userId));
  });
  app.patch("/restaurants/me", rate, authenticated, async (context) => {
    const body = validateWithSchema(updateOwnedRestaurantBodySchema, await parseWorkerJson(context.req.raw));
    if (isCatalogWriterEnabled(context.env) && affectsPublicCatalog(body)) return respondCatalogMutation(context,
      await submitCatalogMutation(context, { type: "restaurant.patch", input: body },await legacyCatalogRestaurant(context)), 200);
    const operationId = isCatalogWriterEnabled(context.env) ? catalogOperationId(context) : null;
    const services = await context.get("getServices")();
    const saved = await services.restaurants.updateOwnedRestaurant(context.get("auth").userId, body,actorFromAuth(context.get('auth')));
    if (operationId && context.req.header("X-Vapt-Catalog-Protocol") === "1") return context.json({ result: saved,
      receipt: { operationId, restaurantId: saved.id, phase: "ready", version: null, committed: true, retryable: false } });
    return context.json(saved);
  });

  app.get("/restaurants/me/menu-items", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.menu.listOwnedMenuItems(context.get("auth").userId));
  });
  app.post("/restaurants/me/menu-items", rate, authenticated, async (context) => {
    const body = validateWithSchema(createMenuItemBodySchema, await parseWorkerJson(context.req.raw));
    if (isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context, { type: "item.create", input: body },await legacyCatalogRestaurant(context)), 201);
    const services = await context.get("getServices")();
    return context.json(await services.menu.createOwnedMenuItem(context.get("auth").userId, body,actorFromAuth(context.get('auth'))), 201);
  });
  app.patch("/restaurants/me/menu-items/:itemId", rate, authenticated, async (context) => {
    const params = validateWithSchema(menuItemParamsSchema, context.req.param());
    const body = validateWithSchema(updateMenuItemBodySchema, await parseWorkerJson(context.req.raw));
    if (isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context, { type: "item.patch", itemId: params.itemId, input: body },await legacyCatalogRestaurant(context)), 200);
    const services = await context.get("getServices")();
    return context.json(await services.menu.updateOwnedMenuItem(context.get("auth").userId, params.itemId, body,actorFromAuth(context.get('auth'))));
  });
  app.delete("/restaurants/me/menu-items/:itemId", rate, authenticated, async (context) => {
    const params = validateWithSchema(menuItemParamsSchema, context.req.param());
    if (isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context, { type: "item.delete", itemId: params.itemId },await legacyCatalogRestaurant(context)), 204);
    const services = await context.get("getServices")();
    await services.menu.deleteOwnedMenuItem(context.get("auth").userId, params.itemId,actorFromAuth(context.get('auth')));
    return context.body(null, 204);
  });

  app.get('/restaurants/:restaurantId/slug-availability',rate,authenticated,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param());
    const {slug}=validateWithSchema(slugAvailabilityQuerySchema,context.req.query());const services=await context.get('getServices')();
    context.header('Cache-Control','no-store');return context.json(await services.restaurants.checkSlugAvailability({userId:context.get('auth').userId,restaurantId},slug));
  });
  app.get('/restaurants/:restaurantId',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.restaurants.getRestaurant({ userId:context.get('auth').userId,restaurantId }));
  });
  app.patch('/restaurants/:restaurantId',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const body=validateWithSchema(updateOwnedRestaurantBodySchema,await parseWorkerJson(context.req.raw));
    if(isCatalogWriterEnabled(context.env) && affectsPublicCatalog(body)) return respondCatalogMutation(context,
      await submitCatalogMutation(context,{type:'restaurant.patch',input:body},restaurantId),200);
    const operationId=isCatalogWriterEnabled(context.env)?catalogOperationId(context):null;
    const services=await context.get('getServices')();
    const saved=await services.restaurants.updateRestaurant({ ...actorFromAuth(context.get('auth')),restaurantId },body);
    if(operationId && context.req.header("X-Vapt-Catalog-Protocol")==="1") return context.json({result:saved,
      receipt:{operationId,restaurantId,phase:"ready",version:null,committed:true,retryable:false}});
    return context.json(saved);
  });
  app.get('/restaurants/:restaurantId/menu-items',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantMenuParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.menu.listMenuItems({ userId:context.get('auth').userId,restaurantId }));
  });
  app.post('/restaurants/:restaurantId/menu-items',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantMenuParamsSchema,context.req.param());
    const body=validateWithSchema(createMenuItemBodySchema,await parseWorkerJson(context.req.raw));
    if(isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context,{type:'item.create',input:body},restaurantId),201);
    const services=await context.get('getServices')();
    return context.json(await services.menu.createMenuItem({ ...actorFromAuth(context.get('auth')),restaurantId },body),201);
  });
  app.patch('/restaurants/:restaurantId/menu-items/:itemId',rate,authenticated,async context=>{
    const { restaurantId,itemId }=validateWithSchema(restaurantMenuItemParamsSchema,context.req.param());
    const body=validateWithSchema(updateMenuItemBodySchema,await parseWorkerJson(context.req.raw));
    if(isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context,{type:'item.patch',itemId,input:body},restaurantId),200);
    const services=await context.get('getServices')();
    return context.json(await services.menu.updateMenuItem({ ...actorFromAuth(context.get('auth')),restaurantId },itemId,body));
  });
  app.delete('/restaurants/:restaurantId/menu-items/:itemId',rate,authenticated,async context=>{
    const { restaurantId,itemId }=validateWithSchema(restaurantMenuItemParamsSchema,context.req.param());
    if(isCatalogWriterEnabled(context.env)) return respondCatalogMutation(context,
      await submitCatalogMutation(context,{type:'item.delete',itemId},restaurantId),204);
    const services=await context.get('getServices')();
    await services.menu.deleteMenuItem({ ...actorFromAuth(context.get('auth')),restaurantId },itemId);
    return context.body(null,204);
  });

  const enabledCatalog: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
    if (!isCatalogWriterEnabled(context.env)) throw new AppError(404, "not_found", "Not found");
    await next();
  };
  app.get("/restaurants/me/catalog-operations/:operationId", rate, enabledCatalog, authenticated, async context =>
    context.json(await controlCatalogOperation(context, "status",await legacyCatalogRestaurant(context))));
  app.post("/restaurants/me/catalog-operations/:operationId/retry", rate, enabledCatalog, authenticated, async context => {
    validateWithSchema(z.object({}).strict(), await parseWorkerJson(context.req.raw));
    return context.json(await controlCatalogOperation(context, "retry",await legacyCatalogRestaurant(context)));
  });
  app.post("/restaurants/me/catalog/rebuild", rate, enabledCatalog, authenticated, async context => {
    validateWithSchema(z.object({}).strict(), await parseWorkerJson(context.req.raw));
    return respondCatalogMutation(context, await submitCatalogMutation(context, { type: "rebuild" },await legacyCatalogRestaurant(context)), 200);
  });

  app.get('/restaurants/:restaurantId/catalog-operations/:operationId',rate,enabledCatalog,authenticated,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema, {restaurantId:context.req.param('restaurantId')});
    return context.json(await controlCatalogOperation(context,'status',restaurantId));
  });
  app.post('/restaurants/:restaurantId/catalog-operations/:operationId/retry',rate,enabledCatalog,authenticated,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,{restaurantId:context.req.param('restaurantId')});
    validateWithSchema(z.object({}).strict(),await parseWorkerJson(context.req.raw));
    return context.json(await controlCatalogOperation(context,'retry',restaurantId));
  });
  app.post('/restaurants/:restaurantId/catalog/rebuild',rate,enabledCatalog,authenticated,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param());
    validateWithSchema(z.object({}).strict(),await parseWorkerJson(context.req.raw));
    return respondCatalogMutation(context,await submitCatalogMutation(context,{type:'rebuild'},restaurantId),200);
  });

  app.get("/restaurants/me/kitchen/orders", rate, authenticated, async (context) => {
    const services = await context.get("getServices")();
    return context.json(await services.kitchen.listActiveOwnedOrders(context.get("auth").userId));
  });
  app.patch("/restaurants/me/kitchen/orders/:orderId/status", rate, authenticated, async (context) => {
    const params = validateWithSchema(kitchenOrderParamsSchema, context.req.param());
    const body = validateWithSchema(updateKitchenOrderStatusBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.kitchen.updateOwnedOrderStatus(context.get("auth").userId, params.orderId, body.status,actorFromAuth(context.get('auth'))));
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
    return context.json(await services.tableSessions.closeOwnedSession(context.get("auth").userId, params.sessionId,actorFromAuth(context.get('auth'))));
  });
  app.post("/restaurants/me/table-sessions/:sessionId/transfer", rate, authenticated, async (context) => {
    const params = validateWithSchema(tableSessionParamsSchema, context.req.param());
    const body = validateWithSchema(transferTableSessionBodySchema, await parseWorkerJson(context.req.raw));
    const services = await context.get("getServices")();
    return context.json(await services.tableSessions.transferOwnedSession(
      context.get("auth").userId, params.sessionId, body.tableNumber,actorFromAuth(context.get("auth")),
    ));
  });
  app.get('/restaurants/:restaurantId/kitchen/orders',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.kitchen.listActiveOrders({ userId:context.get('auth').userId,restaurantId }));
  });
  app.patch('/restaurants/:restaurantId/kitchen/orders/:orderId/status',rate,authenticated,async context=>{
    const { restaurantId,orderId }=validateWithSchema(scopedKitchenOrderParamsSchema,context.req.param());
    const body=validateWithSchema(updateKitchenOrderStatusBodySchema,await parseWorkerJson(context.req.raw));
    const services=await context.get('getServices')();
    return context.json(await services.kitchen.updateOrderStatus({ ...actorFromAuth(context.get('auth')),restaurantId },orderId,body.status));
  });
  app.get('/restaurants/:restaurantId/overview',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const query=validateWithSchema(overviewQuerySchema,context.req.query());
    const services=await context.get('getServices')();
    return context.json(await services.overview.getOverview({ userId:context.get('auth').userId,restaurantId },query.period));
  });
  app.get('/restaurants/:restaurantId/table-sessions',rate,authenticated,async context=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.tableSessions.listActiveSessions({ userId:context.get('auth').userId,restaurantId }));
  });
  app.get('/restaurants/:restaurantId/table-sessions/:sessionId',rate,authenticated,async context=>{
    const { restaurantId,sessionId }=validateWithSchema(scopedTableSessionParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.tableSessions.getSession({ userId:context.get('auth').userId,restaurantId },sessionId));
  });
  app.post('/restaurants/:restaurantId/table-sessions/:sessionId/close',rate,authenticated,async context=>{
    const { restaurantId,sessionId }=validateWithSchema(scopedTableSessionParamsSchema,context.req.param());
    const services=await context.get('getServices')();
    return context.json(await services.tableSessions.closeSession({ ...actorFromAuth(context.get('auth')),restaurantId },sessionId));
  });
  app.post('/restaurants/:restaurantId/table-sessions/:sessionId/transfer',rate,authenticated,async context=>{
    const { restaurantId,sessionId }=validateWithSchema(scopedTableSessionParamsSchema,context.req.param());
    const body=validateWithSchema(transferTableSessionBodySchema,await parseWorkerJson(context.req.raw));
    const services=await context.get('getServices')();
    return context.json(await services.tableSessions.transferSession({ ...actorFromAuth(context.get('auth')),restaurantId },sessionId,body.tableNumber));
  });
}
