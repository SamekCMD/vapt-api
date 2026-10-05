import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import { createApiServices } from "./api-services.js";

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
