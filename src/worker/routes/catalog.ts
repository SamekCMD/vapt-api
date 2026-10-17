import type { R2Bucket, Request as PlatformRequest } from "@cloudflare/workers-types";
import type { Hono } from "hono";
import { AppError } from "../../lib/errors.js";
import type { WorkerHonoEnv } from "../app.js";
import type { WorkerBindings } from "../environment.js";
import { workerRateLimit } from "../http.js";
import { admitCatalogSocket, isCatalogReaderEnabled } from "../catalog/admission.js";
import { createCatalogProjection } from "../catalog/projection.js";

export function publicCatalogProjection(env: WorkerBindings) {
  const bucket = env.PUBLIC_CATALOG_BUCKET;
  if (!bucket?.get || !bucket.put || !bucket.list) throw new AppError(503, "catalog_storage_unavailable", "Public catalog unavailable");
  return createCatalogProjection(bucket as Pick<R2Bucket, "get" | "put" | "list">, env.ENVIRONMENT);
}
export function registerWorkerCatalogRoutes(app: Hono<WorkerHonoEnv>): void {
  app.get("/public/restaurants/:slug/catalog-state", workerRateLimit("public"), async context => {
    context.header("Cache-Control", "no-store");
    if (!isCatalogReaderEnabled(context.env)) throw new AppError(404, "not_found", "Route not found");
    return context.json(await publicCatalogProjection(context.env).readBySlug(context.req.param("slug")));
  });
  app.get("/v1/catalog/restaurants/:restaurantId/socket", workerRateLimit("public"), async context => {
    context.header("Cache-Control", "no-store");
    const admission = admitCatalogSocket(context.req.raw, context.env);
    const published = await publicCatalogProjection(context.env).readRegistration(admission.restaurantId);
    const namespace = context.env.PUBLIC_CATALOG_COORDINATOR;
    if (!namespace) throw new AppError(503, "catalog_coordinator_unavailable", "Public catalog unavailable");
    // Only public, verified metadata crosses the binding. No cookie, bearer or
    // private realtime ticket; returning the original native 101 preserves WS.
    const headers = new Headers({ Origin: admission.origin, Upgrade: "websocket",
      "X-Vapt-Catalog-Version": published.version });
    if (context.req.header("Sec-WebSocket-Protocol")) headers.set("Sec-WebSocket-Protocol", "vapt.catalog.v1");
    const request = new Request(new URL(context.req.path, "https://catalog.internal"), { headers });
    try { return await namespace.get(namespace.idFromName(`${admission.environment}:${admission.restaurantId}`)).fetch(request as unknown as PlatformRequest) as unknown as Response; }
    catch { throw new AppError(503, "catalog_socket_unavailable", "Public catalog unavailable"); }
  });
}
