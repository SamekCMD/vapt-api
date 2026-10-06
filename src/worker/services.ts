import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "hono";

import { createApiServices, type ApiServiceDependencies, type ApiServices } from "../composition/api-services.js";
import type { AppConfig } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import { createOwnershipLookup, createRestaurantAccessChecker } from "../lib/permissions.js";
import { createMenuItemExists } from "../modules/storage/repository.js";
import { createWorkerMenuImageGateway } from "../modules/storage/r2-worker.js";
import { createMenuImageService } from "../modules/storage/service.js";
import { createWorkerDatabase } from "./database.js";
import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";
import { createWorkerRealtimePublisher } from "./realtime/publisher.js";

export type ApiServiceOverrides = Partial<ApiServiceDependencies> & { config?: AppConfig };
export type WorkerServicesFactory = (env: WorkerBindings, context: ExecutionContext) => Promise<ApiServices>;

export async function createWorkerServices(
  env: WorkerBindings,
  context: ExecutionContext,
  overrides: ApiServiceOverrides = {},
): Promise<ApiServices> {
  const config = overrides.config ?? configFromWorkerBindings(env);
  const database = overrides.database ?? createWorkerDatabase(env);
  const ownershipLookup = overrides.ownershipLookup ?? createOwnershipLookup(database);
  const menuImages = overrides.menuImages ?? (config.r2 ? (() => {
    if (!env.R2_BUCKET) throw new AppError(503, "service_unavailable", "Service unavailable");
    return createMenuImageService({
      assertRestaurantAccess: createRestaurantAccessChecker(ownershipLookup),
      menuItemExists: createMenuItemExists(database),
      gateway: createWorkerMenuImageGateway(config.r2, env.R2_BUCKET),
      publicBaseUrl: config.r2.publicBaseUrl,
      uploadUrlTtlSeconds: config.r2.uploadUrlTtlSeconds,
    });
  })() : undefined);
  return createApiServices(config, {
    ...overrides,
    publishCommittedChange: overrides.publishCommittedChange ?? createWorkerRealtimePublisher(env, code => console.error(code)),
    database,
    ownershipLookup,
    menuImages,
    workerId: overrides.workerId ?? `payment-effects-${randomUUID()}`,
    runInBackground: overrides.runInBackground ?? ((task) => {
      context.waitUntil(task.catch(() => {
        console.error("auth_email_failed");
      }));
    }),
    onError: overrides.onError ?? (() => console.error("payment_effect_reconciliation_failed")),
  });
}
