import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import type { AppConfig } from "../../../lib/config.js";
import { buildApp } from "../../../app.js";
import { asaasPixPublicBodySchema } from "./schemas.js";

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

function createToken(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

const validOwnerToken = createToken(
  {
    sub: "user-1",
    email: "owner@example.com",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  validConfig.supabase.jwtSecret,
);

async function withN8nStub(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test n8n server to expose a TCP address");
  }

  const config: AppConfig = {
    ...validConfig,
    n8n: {
      ...validConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    },
  };

  return {
    config,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("asaas setup rejects missing auth", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/asaas/setup",
    payload: {
      restaurantId: "rest-1",
      asaasApiKey: "asaas-key",
      asaasEnvironment: "production",
      asaasBillingDocument: "12345678901",
    },
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test("asaas setup rejects missing fields", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/asaas/setup",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
    payload: {
      restaurantId: "rest-1",
      asaasApiKey: "asaas-key",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: {
      code: "invalid_request",
      message: "Invalid request",
    },
  });

  await app.close();
});

test("asaas setup succeeds for authorized restaurant", async () => {
  const stub = await withN8nStub((request, response) => {
    assert.equal(request.url, "/asaas/setup");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        valid: true,
        webhook_registered: true,
        webhook_id: "wh_123",
        setup_status: "ready",
        message: "Asaas configurado com sucesso",
      }),
    );
  });

  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "POST",
    url: "/billing/asaas/setup",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
    payload: {
      restaurantId: "rest-1",
      asaasApiKey: "asaas-key",
      asaasEnvironment: "production",
      asaasBillingDocument: "12345678901",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    valid: true,
    webhookRegistered: true,
    webhookId: "wh_123",
    setupStatus: "ready",
    message: "Asaas configurado com sucesso",
  });

  await app.close();
  await stub.close();
});

test("asaas setup status succeeds", async () => {
  const stub = await withN8nStub((request, response) => {
    assert.equal(request.url, "/asaas/setup/status?restaurant_id=rest-1");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        restaurant_id: "rest-1",
        name: "Rest 1",
        setup_status: "ready",
        webhook_id: "wh_123",
        webhook_url: "https://n8n.example.com/webhook/asaas",
        last_validated_at: "2026-04-10T00:00:00.000Z",
        last_error: null,
        has_api_key: true,
        asaas_environment: "production",
      }),
    );
  });

  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "GET",
    url: "/billing/asaas/setup/status?restaurantId=rest-1",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    restaurantId: "rest-1",
    name: "Rest 1",
    setupStatus: "ready",
    webhookId: "wh_123",
    webhookUrl: "https://n8n.example.com/webhook/asaas",
    lastValidatedAt: "2026-04-10T00:00:00.000Z",
    lastError: null,
    hasApiKey: true,
    asaasEnvironment: "production",
  });

  await app.close();
  await stub.close();
});

test("public pix rejects browser-controlled totals", () => {
  assert.equal(
    asaasPixPublicBodySchema.safeParse({
      restaurantId: "rest-1",
      orderId: "order-1",
    }).success,
    false,
  );
  assert.equal(
    asaasPixPublicBodySchema.safeParse({
      restaurantId: "rest-1",
      orderId: "order-1",
      publicToken: "opaque-public-order-token-that-is-long-enough",
    }).success,
    true,
  );
  assert.equal(
    asaasPixPublicBodySchema.safeParse({
      restaurantId: "rest-1",
      orderId: "order-1",
      totalPrice: 0.01,
      publicToken: "opaque-public-order-token-that-is-long-enough",
    }).success,
    false,
  );
});

test("asaas pix succeeds", async () => {
  const stub = await withN8nStub((request, response) => {
    assert.equal(request.url, "/asaas/pix/create");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        payment_id: "pay_123",
        qr_code_base64: "base64-qr",
        pix_payload: "pix-code",
        expiration: "2026-04-10T00:30:00.000Z",
        status: "pending",
      }),
    );
  });

  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "POST",
    url: "/billing/asaas/pix",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
    payload: {
      restaurantId: "rest-1",
      orderId: "order-1",
      totalPrice: 99.9,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    paymentId: "pay_123",
    qrCodeBase64: "base64-qr",
    pixPayload: "pix-code",
    expiration: "2026-04-10T00:30:00.000Z",
    status: "pending",
  });

  await app.close();
  await stub.close();
});

test("asaas routes return 403 for unauthorized restaurant access", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/asaas/pix",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
    payload: {
      restaurantId: "rest-2",
      orderId: "order-1",
      totalPrice: 99.9,
    },
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});
