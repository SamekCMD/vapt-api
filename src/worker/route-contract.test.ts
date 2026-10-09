import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { buildApp } from "../app.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import { ROUTE_CONTRACTS, WORKER_ONLY_ROUTE_CONTRACTS } from "./route-contract.js";

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["https://app.vapt.test"],
  logLevel: "silent",
  frontendUrl: new URL("https://app.vapt.test"),
  apiPublicUrl: new URL("https://api.vapt.test"),
  stripe: {
    secretKey: "sk_test_synthetic",
    webhookSecret: "whsec_synthetic",
    webhookToleranceSeconds: 300,
    environment: "test",
    portalConfigurationId: "bpc_synthetic",
    prices: { starter: "price_starter", pro: "price_pro", business: "price_business" },
  },
  security: { publicOrderTokenSecret: "synthetic-order-secret" },
  betterAuth: {
    secret: "synthetic-better-auth-secret-at-least-32-characters",
    url: new URL("https://api.vapt.test"),
    trustedOrigins: ["https://app.vapt.test"],
    databaseUrl: "postgresql://synthetic:synthetic@localhost/synthetic",
    turnstileSecretKey: "synthetic-turnstile",
    email: {
      resendApiKey: "re_synthetic",
      from: "Vapt <noreply@vapt.test>",
      verifyAccountTemplate: "synthetic-verify",
      resetPasswordTemplate: "synthetic-reset",
    },
  },
  r2: {
    accountId: "synthetic-account",
    accessKeyId: "synthetic-access-key",
    secretAccessKey: "synthetic-secret-key",
    bucketName: "synthetic-bucket",
    publicBaseUrl: new URL("https://assets.vapt.test"),
    uploadUrlTtlSeconds: 300,
  },
  mercadoPago: {
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    redirectUri: new URL("https://api.vapt.test/payments/mercado-pago/oauth/callback"),
    webhookSecret: "synthetic-webhook-secret",
    tokenEncryptionKey: Buffer.alloc(32, 1),
    credentialKeyId: "synthetic-key-id",
    environment: "sandbox",
    testAccessToken: "APP_USR-synthetic",
  },
};

const authRuntime: AuthRuntime = {
  async handler() { return new Response(null, { status: 404 }); },
  async getSession() { return null; },
  async close() {},
};

const database = {
  async query() { return { rows: [] }; },
  async connect() {
    return { async query() { return { rows: [] }; }, release() {} };
  },
} as unknown as Database;

test("additive realtime contracts are Worker-only public-rate routes", () => {
  assert.deepEqual(WORKER_ONLY_ROUTE_CONTRACTS, [
    { method: "POST", path: "/v1/realtime/tickets", group: "public", auth: false },
    { method: "GET", path: "/v1/realtime/restaurants/:restaurantId/socket", group: "public", auth: false },
  ]);
});

test("route contract covers every enabled Fastify method and path", async () => {
  const app = await buildApp(config, { authRuntime, database, startPaymentReconciliation: false });
  try {
    assert.equal(ROUTE_CONTRACTS.length, 44);
    for (const route of ROUTE_CONTRACTS) {
      assert.equal(app.hasRoute({ method: route.method, url: route.path }), true, `${route.method} ${route.path}`);
    }
  } finally {
    await app.close();
  }
});

test("optional Fastify routes are absent without their configuration", async () => {
  const app = await buildApp({ ...config, mercadoPago: undefined, r2: undefined }, {
    authRuntime,
    database,
    startPaymentReconciliation: false,
  });
  try {
    for (const route of ROUTE_CONTRACTS.filter((entry) => entry.condition)) {
      assert.equal(app.hasRoute({ method: route.method, url: route.path }), false, `${route.method} ${route.path}`);
    }
    assert.equal(app.hasRoute({ method: "POST", url: "/orders/:orderId/payments/manual-confirmation" }), true);
  } finally {
    await app.close();
  }
});
