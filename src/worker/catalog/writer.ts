import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import type { CatalogActor, CatalogMutation, CommandOutcome } from "../../modules/catalog-publication/contracts.js";
import { allocateOnboardingRestaurantId, validateCatalogCommand } from "../../modules/catalog-publication/policy.js";
import type { WorkerHonoEnv } from "../app.js";
import type { WorkerBindings } from "../environment.js";
import type { CatalogCoordinator } from "./runner.js";
import { unwrapCatalogRpc } from "./rpc.js";
import type { MenuImageContentType } from "../../modules/storage/service.js";

const uuid = z.string().uuid().transform(value => value.toLowerCase());

export function isCatalogWriterEnabled(env: Pick<WorkerBindings, "PUBLIC_CATALOG_WRITER_ENABLED">): boolean {
  if (env.PUBLIC_CATALOG_WRITER_ENABLED === undefined || env.PUBLIC_CATALOG_WRITER_ENABLED === "false") return false;
  if (env.PUBLIC_CATALOG_WRITER_ENABLED === "true") return true;
  throw new AppError(503, "catalog_configuration_invalid", "Catalog publication unavailable");
}

export async function requireCatalogActor(context: Context<WorkerHonoEnv>): Promise<CatalogActor> {
  const cached = context.get("catalogActor");
  if (cached) return cached; // Request-local verified metadata only, never a cross-request auth cache.
  if (!context.req.raw.headers.has("cookie")) throw new AppError(401, "unauthorized", "Unauthorized");
  const getServices = context.get("getServices");
  if (!getServices) throw new AppError(503, "service_unavailable", "Service unavailable");
  const services = await getServices();
  const session = await services.authRuntime.getSession(context.req.raw.headers);
  if (!session || session.session.userId !== session.user.id || session.session.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }
  const actor = { userId: session.user.id, sessionId: session.session.id, sessionExpiresAt: session.session.expiresAt.getTime() };
  context.set("auth", { userId: session.user.id, email: session.user.email ?? null, role: "authenticated",
    sessionId:actor.sessionId,sessionExpiresAt:actor.sessionExpiresAt });
  context.set("catalogActor", actor);
  return actor;
}

export function catalogOperationId(context: Context<WorkerHonoEnv>): string {
  const protocol = context.req.header("X-Vapt-Catalog-Protocol");
  if (protocol && protocol !== "1") throw new AppError(400, "invalid_request", "Invalid request");
  const key = context.req.header("Idempotency-Key");
  if (protocol === "1" && !key) throw new AppError(400, "invalid_request", "Invalid request");
  return key ? validateWithSchema(uuid, key) : randomUUID();
}

function room(context: Context<WorkerHonoEnv>, restaurantId: string): Pick<CatalogCoordinator, "submit" | "status" | "retry"> {
  const namespace = context.env.PUBLIC_CATALOG_COORDINATOR;
  if (!namespace) throw new AppError(503, "catalog_coordinator_unavailable", "Catalog publication unavailable");
  const target = namespace.get(namespace.idFromName(`${context.env.ENVIRONMENT}:${restaurantId}`));
  return {
    submit: async command => unwrapCatalogRpc(await target.submit(command)),
    status: async access => unwrapCatalogRpc(await target.status(access)),
    retry: async access => unwrapCatalogRpc(await target.retry(access)),
  };
}

async function ownedRestaurant(context: Context<WorkerHonoEnv>, actor: CatalogActor) {
  const services = await context.get("getServices")();
  try { return await services.restaurants.getOwnedRestaurant(actor.userId); }
  catch (error) { if (error instanceof AppError && error.statusCode === 404) return null; throw error; }
}

async function imageRoom(context: Context<WorkerHonoEnv>, restaurantId: string) {
  const actor = await requireCatalogActor(context);
  const owned = await ownedRestaurant(context, actor);
  if (owned?.id !== restaurantId) throw new AppError(403, "forbidden", "Forbidden");
  const namespace = context.env.PUBLIC_CATALOG_COORDINATOR;
  if (!namespace) throw new AppError(503, "catalog_coordinator_unavailable", "Catalog publication unavailable");
  return { actor, target: namespace.get(namespace.idFromName(`${context.env.ENVIRONMENT}:${restaurantId}`)) };
}

export async function prepareCatalogImage(context: Context<WorkerHonoEnv>, params: { restaurantId: string; itemId: string },
  body: { contentType: MenuImageContentType; contentLength: number }) {
  const leaseId = catalogOperationId(context);
  const { actor, target } = await imageRoom(context, params.restaurantId);
  return unwrapCatalogRpc(await target.prepareImage({ ...params, ...body, actor, leaseId }));
}

export async function retireCatalogImage(context: Context<WorkerHonoEnv>, params: { restaurantId: string; itemId: string }) {
  const objectKey = validateWithSchema(z.string().min(1).max(200), context.req.query("objectKey"));
  const parts = objectKey.split("/");
  if (parts.length !== 3 || !parts.every(part => uuid.safeParse(part).success)
    || parts[0] !== params.restaurantId || parts[1] !== params.itemId) throw new AppError(400, "invalid_image_key", "Invalid image key");
  const { actor, target } = await imageRoom(context, params.restaurantId);
  return unwrapCatalogRpc(await target.retireImage({ ...params, objectKey, actor }));
}

export async function reconcileCatalogImages(context: Context<WorkerHonoEnv>) {
  const restaurantId = validateWithSchema(uuid, context.req.param("restaurantId"));
  const { actor, target } = await imageRoom(context, restaurantId);
  return unwrapCatalogRpc(await target.reconcileImages({ restaurantId, actor }));
}

export async function submitCatalogMutation(context: Context<WorkerHonoEnv>, mutation: CatalogMutation): Promise<CommandOutcome<unknown>> {
  const operationId = catalogOperationId(context);
  const actor = await requireCatalogActor(context);
  if (!context.env.PUBLIC_CATALOG_COORDINATOR) throw new AppError(503, "catalog_coordinator_unavailable", "Catalog publication unavailable");
  const owned = await ownedRestaurant(context, actor);
  const restaurantId = mutation.type === "onboarding" ? await allocateOnboardingRestaurantId(actor.userId, operationId) : owned?.id;
  if (!restaurantId) throw new AppError(404, "not_found", "Restaurant not found");
  const coordinator = room(context, restaurantId);
  if (mutation.type === "onboarding" && owned) {
    if (owned.id !== restaurantId) throw new AppError(409, "restaurant_conflict", "Restaurant already exists");
    try { await coordinator.status({ operationId, restaurantId, actor }); }
    catch (error) {
      if (error instanceof AppError && error.statusCode === 404) throw new AppError(409, "restaurant_conflict", "Restaurant already exists");
      throw error;
    }
  }
  return coordinator.submit(validateCatalogCommand({ operationId, restaurantId, actor, mutation }));
}

export async function controlCatalogOperation(context: Context<WorkerHonoEnv>, action: "status" | "retry") {
  const operationId = validateWithSchema(uuid, context.req.param("operationId"));
  const actor = await requireCatalogActor(context);
  const owned = await ownedRestaurant(context, actor);
  const onboardingId = await allocateOnboardingRestaurantId(actor.userId, operationId);
  const requested = context.req.query("restaurantId");
  const restaurantId = requested ? validateWithSchema(uuid, requested) : owned?.id ?? onboardingId;
  if (restaurantId !== owned?.id && restaurantId !== onboardingId) throw new AppError(403, "forbidden", "Forbidden");
  return room(context, restaurantId)[action]({ operationId, restaurantId, actor });
}

export function respondCatalogMutation(context: Context<WorkerHonoEnv>, outcome: CommandOutcome<unknown>, success: 200 | 201 | 204) {
  if (outcome.receipt.phase !== "ready") return context.json(outcome, 202);
  if (context.req.header("X-Vapt-Catalog-Protocol") === "1") return context.json(outcome, success === 204 ? 200 : success);
  if (success === 204) return context.body(null, 204);
  if (outcome.result === undefined) throw new AppError(503, "catalog_result_unavailable", "Catalog operation result unavailable");
  return context.json(outcome.result, success);
}
