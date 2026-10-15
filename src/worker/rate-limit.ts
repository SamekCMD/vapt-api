import { ConfigError } from "../lib/config.js";
import type { RateLimitBackend, RateLimitGroup } from "../plugins/rate-limit.js";
import type { WorkerBindings, WorkerRateLimitBinding } from "./environment.js";

const groupBindings = {
  auth: "AUTH_RATE_LIMIT",
  billing: "BILLING_RATE_LIMIT",
  orders: "ORDERS_RATE_LIMIT",
  storage: "STORAGE_RATE_LIMIT",
  webhooks: "WEBHOOKS_RATE_LIMIT",
  public: "PUBLIC_RATE_LIMIT",
} as const satisfies Record<Exclude<RateLimitGroup, "health">, keyof WorkerBindings>;

export function createWorkerRateLimitBackend(env: WorkerBindings): RateLimitBackend {
  return {
    async limit(group, actorKey) {
      if (group === "health") {
        return { allowed: true };
      }
      const name = groupBindings[group];
      const binding = env[name] as WorkerRateLimitBinding | undefined;
      if (!binding || typeof binding.limit !== "function") {
        throw new ConfigError(`Missing required Worker binding: ${name}`);
      }
      const result = await binding.limit({ key: actorKey });
      return { allowed: result.success };
    },
  };
}
