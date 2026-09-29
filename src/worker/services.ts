import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "hono";
import { Pool } from "pg";

import { createApiServices, type ApiServiceDependencies, type ApiServices } from "../composition/api-services.js";
import type { AppConfig } from "../lib/config.js";
import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";

export type ApiServiceOverrides = Partial<ApiServiceDependencies> & { config?: AppConfig };
export type WorkerServicesFactory = (env: WorkerBindings, context: ExecutionContext) => Promise<ApiServices>;

export async function createWorkerServices(
  env: WorkerBindings,
  context: ExecutionContext,
  overrides: ApiServiceOverrides = {},
): Promise<ApiServices> {
  const config = overrides.config ?? configFromWorkerBindings(env);
  const database = overrides.database ?? new Pool({ connectionString: env.HYPERDRIVE!.connectionString });
  return createApiServices(config, {
    ...overrides,
    database,
    workerId: overrides.workerId ?? `payment-effects-${randomUUID()}`,
    runInBackground: overrides.runInBackground ?? ((task) => {
      context.waitUntil(task.catch(() => {
        console.error("auth_email_failed");
      }));
    }),
    onError: overrides.onError ?? (() => console.error("payment_effect_reconciliation_failed")),
  });
}
