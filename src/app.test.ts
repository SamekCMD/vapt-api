import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./lib/config.js";
import { buildApp } from "./app.js";

const validConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: {
      app: "app-secret",
      webhookSetup: "setup-secret",
      admin: "admin-secret",
    },
  },
  webhooks: {
    stripe: {
      signingSecret: "whsec_test",
      toleranceSeconds: 300,
    },
  },
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
};

test("GET /health returns ok", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});

test("payment module registers the manual provider", async () => {
  const app = await buildApp(validConfig);

  assert.equal(app.hasDecorator("payments"), true);
  assert.deepEqual(app.payments.registry.codes(), ["manual"]);
  assert.equal(typeof app.payments.reconciliation.runOnce, "function");

  await app.close();
});

test("GET /health/ready returns ready", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ready",
    paymentEffects: { pending: null, lastRunAt: null, lastError: null },
  });

  await app.close();
});

test("unknown routes return standardized not_found errors", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/missing",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: "not_found",
      message: "Route not found",
    },
  });

  await app.close();
});

test("allowed CORS origin is echoed back", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "http://localhost:5173",
    },
  });

  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");

  await app.close();
});

test("blocked CORS origin is rejected", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "https://evil.example.com",
    },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });

  await app.close();
});

test("buildApp registers Mercado Pago OAuth routes only when configured", async () => {
  const app = await buildApp({
    ...validConfig,
    frontendUrl: new URL("https://app.vapt.test"),
    apiPublicUrl: new URL("https://api.vapt.test"),
    mercadoPago: {
      clientId: "app-123",
      clientSecret: "client-secret",
      redirectUri: new URL("https://api.vapt.test/payments/mercado-pago/oauth/callback"),
      webhookSecret: "webhook-secret",
      tokenEncryptionKey: Buffer.alloc(32, 5),
      credentialKeyId: "env-v1",
      environment: "sandbox",
    },
  });
  assert.deepEqual(app.payments.registry.codes(), ["manual", "mercado_pago"]);

  const response = await app.inject({
    method: "POST",
    url: "/restaurants/10000000-0000-4000-8000-000000000001/payments/mercado-pago/connect",
    payload: { environment: "sandbox" },
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});