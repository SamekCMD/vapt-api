import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerRateLimitBackend } from "./rate-limit.js";
import type { WorkerBindings } from "./environment.js";

function bindings() {
  const calls = new Map<string, string[]>();
  function binding(name: string) {
    const keys: string[] = [];
    calls.set(name, keys);
    return { async limit({ key }: { key: string }) { keys.push(key); return { success: true }; } };
  }
  const env = {
    ENVIRONMENT: "preview",
    AUTH_RATE_LIMIT: binding("auth"),
    BILLING_RATE_LIMIT: binding("billing"),
    ORDERS_RATE_LIMIT: binding("orders"),
    STORAGE_RATE_LIMIT: binding("storage"),
    WEBHOOKS_RATE_LIMIT: binding("webhooks"),
    PUBLIC_RATE_LIMIT: binding("public"),
  } as WorkerBindings;
  return { env, calls };
}

test("Worker backend routes each policy to its dedicated binding with actor key", async () => {
  const { env, calls } = bindings();
  const backend = createWorkerRateLimitBackend(env);
  for (const group of ["auth", "billing", "orders", "storage", "webhooks", "public"] as const) {
    assert.deepEqual(await backend.limit(group, `${group}:203.0.113.10`), { allowed: true });
    assert.deepEqual(calls.get(group), [`${group}:203.0.113.10`]);
  }
  assert.deepEqual(await backend.limit("health", "health:203.0.113.10"), { allowed: true });
  assert.equal([...calls.values()].flat().length, 6);
});

test("Worker backend fails closed when a protected binding is absent", async () => {
  const { env } = bindings();
  env.AUTH_RATE_LIMIT = undefined;
  const backend = createWorkerRateLimitBackend(env);
  await assert.rejects(() => backend.limit("auth", "auth:203.0.113.10"), /AUTH_RATE_LIMIT/);
});

test("Worker binding denial is propagated without fabricated counters", async () => {
  const { env } = bindings();
  env.AUTH_RATE_LIMIT = { async limit() { return { success: false }; } };
  assert.deepEqual(
    await createWorkerRateLimitBackend(env).limit("auth", "auth:203.0.113.10"),
    { allowed: false },
  );
});
