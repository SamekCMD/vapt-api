import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { AppConfig } from "../../../lib/config.js";
import { buildApp as buildVaptApp } from "../../../app.js";
import type { AuthRuntime } from "../../auth/runtime.js";

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
      admin: "admin-secret",
    },
  },
  webhooks: {
    stripe: {
      signingSecret: "whsec_test",
      toleranceSeconds: 300,
    },
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
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
  },
};

const testAuthRuntime: AuthRuntime = {
  async handler() {
    return new Response(null, { status: 404 });
  },
  async getSession(headers) {
    return headers.get("cookie")?.includes("better-auth.session_token=valid")
      ? {
          user: { id: "user-1", email: "owner@example.com", name: "Owner" },
          session: {
            id: "session-1",
            userId: "user-1",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          },
        }
      : null;
  },
  async close() {},
};

function buildApp(config: AppConfig) {
  return buildVaptApp(config, { authRuntime: testAuthRuntime });
}

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

test("stripe checkout rejects missing auth", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/checkout",
    payload: {
      restaurantId: "rest-1",
      email: "owner@example.com",
      planType: "starter",
      priceId: "price_123",
    },
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test("stripe checkout rejects missing fields", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/checkout",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-1",
      email: "owner@example.com",
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

test("stripe checkout succeeds for authorized restaurant", async () => {
  const stub = await withN8nStub((request, response) => {
    assert.equal(request.url, "/stripe/subscription/create");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        clientSecret: "cs_test_123",
        subscriptionId: "sub_123",
        customerId: "cus_123",
        autoCharged: false,
      }),
    );
  });
  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/checkout",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-1",
      email: "owner@example.com",
      planType: "starter",
      priceId: "price_123",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    clientSecret: "cs_test_123",
    subscriptionId: "sub_123",
    customerId: "cus_123",
    autoCharged: false,
  });

  await app.close();
  await stub.close();
});

test("stripe subscription change succeeds", async () => {
  const stub = await withN8nStub((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        subscriptionId: "sub_123",
        plan_type: "pro",
        status: "updated",
        autoCharged: true,
      }),
    );
  });
  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/subscription/change",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-1",
      targetPlanType: "pro",
      targetPriceId: "price_pro",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    subscriptionId: "sub_123",
    planType: "pro",
    status: "updated",
    autoCharged: true,
  });

  await app.close();
  await stub.close();
});

test("stripe subscription cancel succeeds", async () => {
  const stub = await withN8nStub((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        subscriptionId: "sub_123",
        status: "canceled",
      }),
    );
  });
  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/subscription/cancel",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-1",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    subscriptionId: "sub_123",
    status: "canceled",
  });

  await app.close();
  await stub.close();
});

test("stripe subscription status succeeds", async () => {
  const stub = await withN8nStub((request, response) => {
    assert.equal(request.url, "/stripe/subscription/status?restaurant_id=rest-1");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        plan_type: "starter",
        plan_status: "active",
        trial_ends_at: null,
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_123",
      }),
    );
  });
  const app = await buildApp(stub.config);

  const response = await app.inject({
    method: "GET",
    url: "/billing/stripe/subscription?restaurantId=rest-1",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    planType: "starter",
    planStatus: "active",
    trialEndsAt: null,
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
  });

  await app.close();
  await stub.close();
});

test("stripe routes return 403 for unauthorized restaurant access", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/subscription/cancel",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-2",
    },
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});
