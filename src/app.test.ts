import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./lib/config.js";
import type { Database } from "./lib/database.js";
import { buildApp as buildVaptApp } from "./app.js";
import type { AuthRuntime } from "./modules/auth/runtime.js";
import Stripe from "stripe";
import { createStripeClient } from "./modules/billing/stripe/client.js";

const validConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  frontendUrl: new URL("https://app.vapt.test"),
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: {
      app: "app-secret",
      admin: "admin-secret",
    },
  },
  stripe: {
    secretKey: "sk_test_vapt",
    webhookSecret: "whsec_test",
    webhookToleranceSeconds: 300,
    environment: "test",
    portalConfigurationId: "bpc_vapt",
    prices: { starter: "price_starter", pro: "price_pro", business: "price_business" },
  },
  security: { publicOrderTokenSecret: "public-order-token-secret" },
  betterAuth: {
    secret: "better-auth-secret-at-least-32-characters",
    url: new URL("https://api.vapt.test"),
    trustedOrigins: ["https://app.vapt.test"],
    databaseUrl: "postgresql://vapt:password@db.vapt.test/vapt",
    turnstileSecretKey: "turnstile-secret-key",
    email: {
      resendApiKey: "re_test_key",
      from: "Vapt <noreply@vapt.test>",
      verifyAccountTemplate: "verify-account-template",
      resetPasswordTemplate: "reset-password-template",
    },
  },
};

const testAuthRuntime: AuthRuntime = {
  async handler() {
    return new Response(null, { status: 404 });
  },
  async getSession() {
    return null;
  },
  async close() {},
};

function buildApp(config: AppConfig) {
  return buildVaptApp(config, { authRuntime: testAuthRuntime });
}

test("buildApp composes SDK-verified billing webhooks into the injected Neon event transaction", async () => {
  const operations: string[] = [];
  const query = async (sql: string) => {
    operations.push(sql);
    if (sql.includes("insert into public.billing_provider_events")) return { rows: [{ attemptCount: 1 }] };
    if (sql.includes("for update")) return { rows: [{ attemptCount: 1, processingStatus: "processing" }] };
    return { rows: [] };
  };
  const database = { query, async connect() { return { query, release() {} }; } } as unknown as Database;
  const app = await buildVaptApp(validConfig, { database, authRuntime: testAuthRuntime });
  const raw = JSON.stringify({ id: "evt_composed", type: "customer.created", created: 1790500000,
    livemode: false, data: { object: { id: "cus_vapt", object: "customer" } } });
  const client = createStripeClient(validConfig.stripe);
  const signature = await client.webhooks.generateTestHeaderStringAsync({ payload: raw,
    secret: validConfig.stripe.webhookSecret, cryptoProvider: Stripe.createSubtleCryptoProvider() });
  const response = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: raw,
    headers: { "content-type": "application/json", "stripe-signature": signature } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().ignored, true);
  assert.ok(operations.some(sql => sql.includes("processing_status = $3::text")));
  assert.ok(operations.includes("COMMIT"));
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/asaas" })).statusCode, 404);
  await app.close();
});

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

test("CORS preflight allows credentialed DELETE requests and CAPTCHA headers", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "OPTIONS",
    url: "/restaurants/10000000-0000-4000-8000-000000000001/payments/mercado-pago/connection",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "content-type,x-captcha-response",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.match(
    String(response.headers["access-control-allow-methods"]),
    /(?:^|,\s*)DELETE(?:,|$)/,
  );
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.match(
    String(response.headers["access-control-allow-headers"]),
    /X-Captcha-Response/i,
  );

  await app.close();
});

test("CORS preflight allows public order idempotency and token headers", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "OPTIONS",
    url: "/public/orders/10000000-0000-4000-8000-000000000001/feedback",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type,idempotency-key,x-vapt-order-token",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.match(
    String(response.headers["access-control-allow-methods"]),
    /(?:^|,\s*)PUT(?:,|$)/,
  );
  assert.match(
    String(response.headers["access-control-allow-headers"]),
    /(?:^|,\s*)Idempotency-Key(?:,|$)/i,
  );
  assert.match(
    String(response.headers["access-control-allow-headers"]),
    /(?:^|,\s*)X-Vapt-Order-Token(?:,|$)/i,
  );

  await app.close();
});

test("CORS requires an exact configured preview origin", async () => {
  const app = await buildApp({
    ...validConfig,
    corsOrigins: [
      "https://infra-foundation-vapt-web.autoistloko.workers.dev",
      "https://legacy-*.vercel.app",
    ],
  });
  const previewOrigin = "https://infra-foundation-vapt-web.autoistloko.workers.dev";

  const allowedResponse = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: previewOrigin },
  });

  assert.equal(allowedResponse.statusCode, 200);
  assert.equal(allowedResponse.headers["access-control-allow-origin"], previewOrigin);

  const blockedResponse = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "https://legacy-preview.vercel.app",
    },
  });

  assert.equal(blockedResponse.statusCode, 500);

  await app.close();
});

test("blocked CORS origin is rejected", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/auth/sign-in/email",
    headers: {
      origin: "https://evil.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-captcha-response",
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

test("app close releases the injected Better Auth runtime", async () => {
  let closeCalls = 0;
  const app = await buildVaptApp(validConfig, {
    authRuntime: {
      ...testAuthRuntime,
      async close() {
        closeCalls += 1;
      },
    },
  });

  await app.close();

  assert.equal(closeCalls, 1);
});

test("buildApp wires the injected Neon database into public order routes", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{
        order_id: "10000000-0000-4000-8000-000000000001",
        display_id: "9007199254740993",
        restaurant_id: "20000000-0000-4000-8000-000000000002",
        table_session_id: null,
        total_price: "42.90",
        status: "waiting_payment",
        payment_status: null,
        idempotent_replay: false,
      }] };
    },
    async connect() {
      throw new Error("not used");
    },
  } as unknown as Database;
  const app = await buildVaptApp(validConfig, {
    authRuntime: testAuthRuntime,
    database,
  });

  const response = await app.inject({
    method: "POST",
    url: "/public/orders",
    headers: { "idempotency-key": "order-attempt-0001" },
    payload: {
      restaurantSlug: "restaurante-teste",
      channel: "delivery",
      items: [{
        menuItemId: "30000000-0000-4000-8000-000000000003",
        quantity: 1,
      }],
      delivery: {
        name: "Cliente Teste",
        phone: "61999999999",
        street: "Rua Um",
        number: "42",
        neighborhood: "Centro",
        paymentMode: "online",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().displayId, "9007199254740993");
  assert.match(calls[0]?.sql ?? "", /public\.create_public_order_v3/i);
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

test("legacy Asaas billing routes remain disabled", async () => {
  const app = await buildApp(validConfig);

  const setupResponse = await app.inject({
    method: "POST",
    url: "/billing/asaas/setup",
    payload: {},
  });
  const pixResponse = await app.inject({
    method: "POST",
    url: "/billing/asaas/pix/public",
    payload: {},
  });

  assert.equal(setupResponse.statusCode, 404);
  assert.equal(pixResponse.statusCode, 404);

  await app.close();
});
