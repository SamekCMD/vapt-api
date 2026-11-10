import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import { createApiServices } from "./api-services.js";
import { syntheticAuthConfig, syntheticSchemaAuthDependencies } from "../worker/auth-context-test-support.js";
import { createWorkerServices } from "../worker/services.js";
import type { ExecutionContext } from "hono";

const config = {
  nodeEnv: "test",
  stripe: { secretKey: "sk_test_synthetic" },
  security: { publicOrderTokenSecret: "synthetic-order-secret" },
  betterAuth: { databaseUrl: "postgresql://synthetic:synthetic@localhost/synthetic" },
} as AppConfig;

const database = {
  async query() { return { rows: [] }; },
  async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
} as unknown as Database;

const authRuntime: AuthRuntime = {
  async handler() { return new Response(null, { status: 404 }); },
  async getSession() { return null; },
  async close() {},
};
const stripeGateway = {} as StripeGateway;

test("shared composition reuses injected auth and payment dependencies", () => {
  const services = createApiServices(config, {
    database,
    authRuntime,
    stripeGateway,
    workerId: "synthetic-worker",
    startPaymentReconciliation: false,
  });

  assert.strictEqual(services.authRuntime, authRuntime);
  assert.strictEqual(services.stripeGateway, stripeGateway);
  assert.deepEqual(services.payments.registry.codes(), ["manual"]);
  assert.equal(services.payments.reconciliation.snapshot().lastRunAt, null);
});

test("auth factory is lazy, receives request dependencies and explicit runtime wins in Node and Worker composition", async () => {
  let calls = 0;
  const full = { ...config, betterAuth: syntheticAuthConfig() };
  const runner = (_task: Promise<unknown>) => undefined;
  const factory: NonNullable<import("./api-services.js").ApiServiceDependencies["authRuntimeFactory"]> = (actualConfig, deps) => {
    calls++;
    assert.strictEqual(actualConfig, full.betterAuth);
    assert.strictEqual(deps.pool, database);
    assert.strictEqual(deps.runInBackground, runner);
    return authRuntime;
  };
  const services = createApiServices(full, { database, runInBackground: runner, authRuntimeFactory: factory });
  assert.equal(calls, 0);
  assert.strictEqual(services.authRuntime, authRuntime);
  assert.strictEqual(services.authRuntime, authRuntime);
  assert.equal(calls, 1);
  const explicit = createApiServices(full, { database, authRuntime, authRuntimeFactory: factory });
  assert.strictEqual(explicit.authRuntime, authRuntime);
  assert.equal(calls, 1);
  const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const worker = await createWorkerServices({ ENVIRONMENT: "preview" }, execution, { config: full, database, runInBackground: runner, authRuntimeFactory: factory });
  assert.equal(calls, 1);
  assert.strictEqual(worker.authRuntime, authRuntime);
  assert.equal(calls, 2);
  const workerExplicit = await createWorkerServices({ ENVIRONMENT: "preview" }, execution, { config: full, database, authRuntime, authRuntimeFactory: factory });
  assert.strictEqual(workerExplicit.authRuntime, authRuntime);
  assert.equal(calls, 2);
});

test("default Worker factory reuses the engine but not request-owned pools and separates environments", async () => {
  const events: string[] = [];
  const full = { ...config, betterAuth: syntheticAuthConfig() };
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  for (const [owner, environment] of [["a", "preview"], ["b", "preview"], ["c", "production"]] as const) {
    const dep = syntheticSchemaAuthDependencies(owner, events);
    const services = await createWorkerServices({ ENVIRONMENT: environment }, context, { config: full, database: dep.pool as unknown as Database });
    assert.equal(await services.authRuntime.getSession(new Headers({ cookie: "analytics=synthetic" })), null);
  }
  assert.deepEqual(events.filter(x => x.endsWith(":schema")), ["a:schema", "c:schema"]);
});

test("shared composition defers provider initialization until a domain is used", () => {
  const services = createApiServices({ ...config, stripe: undefined as unknown as AppConfig["stripe"] }, {
    database,
    authRuntime,
    workerId: "synthetic-worker",
    startPaymentReconciliation: false,
  });

  assert.strictEqual(services.database, database);
  assert.deepEqual(services.payments.registry.codes(), ["manual"]);
});

test("realtime validation is lazy and does not initialize authentication or providers", async () => {
  const services = createApiServices(config, { database });
  const realtime = services.realtimeAuthorization;
  assert.ok(realtime, "realtime authorization getter must exist");
  assert.deepEqual(await realtime.revalidate([], Date.now()), []);
});
