import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import type { AppConfig } from "../../../lib/config.js";
import { buildApp } from "../../../app.js";
import { createStripeBillingService } from "./service.js";

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
    iss: "https://supabase.example.com/auth/v1",
    aud: "authenticated",
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

function createBillingService(role: "owner" | "admin" | "manager" | "staff" | null) {
  return createStripeBillingService(
    {
      stripe: {
        createSubscription: async () => ({
          data: {
            clientSecret: "secret",
            subscriptionId: "subscription",
            customerId: "customer",
            autoCharged: false,
          },
        }),
        changeSubscription: async () => ({
          data: {
            subscriptionId: "subscription",
            plan_type: "pro",
            status: "active",
            autoCharged: true,
          },
        }),
        cancelSubscription: async () => ({
          data: { subscriptionId: "subscription", status: "canceled" },
        }),
        getSubscriptionStatus: async () => ({
          data: {
            plan_type: "starter",
            plan_status: "active",
            trial_ends_at: null,
            stripe_customer_id: "customer",
            stripe_subscription_id: "subscription",
          },
        }),
      },
    },
    async () => role ? { organizationId: "org-1", role } : null,
  );
}

test("admin can manage billing", async () => {
  const service = createBillingService("admin");

  await assert.doesNotReject(() => service.createCheckout({
    userId: "admin-1",
    restaurantId: "rest-1",
    email: "admin@example.com",
    planType: "starter",
    priceId: "price-1",
  }));
});

test("manager can read billing but cannot mutate it", async () => {
  const service = createBillingService("manager");

  await assert.doesNotReject(() => service.getSubscriptionStatus({
    userId: "manager-1",
    restaurantId: "rest-1",
  }));
  await assert.rejects(
    () => service.cancelSubscription({
      userId: "manager-1",
      restaurantId: "rest-1",
    }),
    (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 403,
  );
});

test("staff and non-members cannot access billing", async () => {
  for (const service of [createBillingService("staff"), createBillingService(null)]) {
    await assert.rejects(
      () => service.getSubscriptionStatus({
        userId: "user-1",
        restaurantId: "rest-1",
      }),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 403,
    );
  }
});

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
      authorization: `Bearer ${validOwnerToken}`,
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
      authorization: `Bearer ${validOwnerToken}`,
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
      authorization: `Bearer ${validOwnerToken}`,
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
      authorization: `Bearer ${validOwnerToken}`,
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
      authorization: `Bearer ${validOwnerToken}`,
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
      authorization: `Bearer ${validOwnerToken}`,
    },
    payload: {
      restaurantId: "rest-2",
    },
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});
