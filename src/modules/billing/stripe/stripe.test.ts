import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { AppConfig } from "../../../lib/config.js";
import type { Database } from "../../../lib/database.js";
import { buildApp as buildVaptApp } from "../../../app.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import {
  createStripeBillingRepository,
  type StripeBillingRepository,
} from "./repository.js";
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
  stripe: {
    prices: {
      starter: "price_server_starter",
      pro: "price_server_pro",
      business: "price_server_business",
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

function buildApp(config: AppConfig, database: Database = {
  async query() {
    return { rows: [{ id: "rest-1" }] };
  },
  async connect() {
    throw new Error("Transactions are not expected in Stripe route tests");
  },
} as unknown as Database) {
  return buildVaptApp(config, { authRuntime: testAuthRuntime, database });
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
      planType: "starter",
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
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), {
        restaurant_id: "rest-1",
        email: "owner@example.com",
        plan_type: "starter",
        price_id: "price_server_starter",
      });
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
      planType: "starter",
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

test("stripe checkout rejects browser-controlled price and email fields", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "POST",
    url: "/billing/stripe/checkout",
    headers: {
      cookie: "better-auth.session_token=valid",
    },
    payload: {
      restaurantId: "rest-1",
      planType: "business",
      priceId: "price_server_starter",
      email: "attacker@example.com",
    },
  });

  assert.equal(response.statusCode, 400);

  await app.close();
});

test("stripe subscription change succeeds", async () => {
  const stub = await withN8nStub((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), {
        restaurant_id: "rest-1",
        target_plan_type: "pro",
        target_price_id: "price_server_pro",
      });
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
  const database = {
    async query() {
      return { rows: [{
        planType: "starter",
        planStatus: "active",
        trialEndsAt: null,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        billingLastError: null,
        subscriptionCanceledAt: null,
      }] };
    },
    async connect() {
      throw new Error("Transactions are not expected in Stripe route tests");
    },
  } as unknown as Database;
  const app = await buildApp(validConfig, database);

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
    billingLastError: null,
    subscriptionCanceledAt: null,
  });

  await app.close();
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

function stripeClientReturningCheckout() {
  return {
    stripe: {
      async createSubscription() {
        return {
          data: {
            clientSecret: "cs_test_123",
            subscriptionId: "sub_123",
            customerId: "cus_123",
            autoCharged: true,
          },
        };
      },
      async changeSubscription() {
        return {
          data: {
            subscriptionId: "sub_123",
            plan_type: "pro",
            status: "updated",
            autoCharged: true,
          },
        };
      },
      async cancelSubscription() {
        return { data: { subscriptionId: "sub_123", status: "canceled" } };
      },
    },
  };
}

function recordingStripeRepository(writes: unknown[]): StripeBillingRepository {
  return {
    async persistCheckoutResult(input) { writes.push(["checkout", input]); },
    async persistChangeResult(input) { writes.push(["change", input]); },
    async persistCancellationResult(input) { writes.push(["cancel", input]); },
    async getStatus() {
      return {
        planType: "starter",
        planStatus: "active",
        trialEndsAt: null,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        billingLastError: null,
        subscriptionCanceledAt: null,
      };
    },
  };
}

test("stripe service persists a valid checkout response for the authorized restaurant", async () => {
  const writes: unknown[] = [];
  const service = createStripeBillingService(
    stripeClientReturningCheckout(),
    async () => true,
    recordingStripeRepository(writes),
    validConfig.stripe.prices,
  );

  const result = await service.createCheckout({
    userId: "user-1",
    restaurantId: "rest-1",
    email: "owner@example.com",
    planType: "starter",
  });

  assert.equal(result.subscriptionId, "sub_123");
  assert.deepEqual(writes, [["checkout", {
    userId: "user-1",
    restaurantId: "rest-1",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    planType: "starter",
    planStatus: "active",
  }]]);
});

test("stripe service does not claim success when Neon persistence fails", async () => {
  const repository = recordingStripeRepository([]);
  repository.persistCheckoutResult = async () => {
    throw new Error("database unavailable");
  };
  const service = createStripeBillingService(
    stripeClientReturningCheckout(),
    async () => true,
    repository,
    validConfig.stripe.prices,
  );

  await assert.rejects(() => service.createCheckout({
    userId: "user-1",
    restaurantId: "rest-1",
    email: "owner@example.com",
    planType: "starter",
  }), /database unavailable/);
});

test("stripe service rejects a plan returned for a different requested entitlement", async () => {
  const client = stripeClientReturningCheckout();
  client.stripe.changeSubscription = async () => ({
    data: {
      subscriptionId: "sub_123",
      plan_type: "business",
      status: "updated",
      autoCharged: true,
    },
  });
  const service = createStripeBillingService(
    client,
    async () => true,
    recordingStripeRepository([]),
    validConfig.stripe.prices,
  );

  await assert.rejects(
    () => service.changeSubscription({
      userId: "user-1",
      restaurantId: "rest-1",
      targetPlanType: "pro",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_upstream_response",
  );
});

test("stripe repository scopes all billing writes to the restaurant owner", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/select plan_type/i.test(sql)) {
        return { rows: [{
          planType: "pro",
          planStatus: "cancelled",
          trialEndsAt: new Date("2026-09-27T00:00:00.000Z"),
          stripeCustomerId: "cus_123",
          stripeSubscriptionId: "sub_123",
          billingLastError: null,
          subscriptionCanceledAt: new Date("2026-09-26T14:00:00.000Z"),
        }] };
      }
      return { rows: [{ id: "10000000-0000-4000-8000-000000000001" }] };
    },
  } as unknown as Database;
  const repository = createStripeBillingRepository(database);
  const scope = {
    userId: "20000000-0000-4000-8000-000000000001",
    restaurantId: "10000000-0000-4000-8000-000000000001",
  };

  await repository.persistCheckoutResult({
    ...scope,
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    planType: "starter",
    planStatus: "active",
  });
  await repository.persistChangeResult({
    ...scope,
    stripeSubscriptionId: "sub_123",
    planType: "pro",
    planStatus: "active",
  });
  await repository.persistCancellationResult({
    ...scope,
    stripeSubscriptionId: "sub_123",
  });
  const status = await repository.getStatus(scope);

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.match(call.sql, /where id = \$1::uuid\s+and owner_id = \$2::uuid/i);
    assert.deepEqual(call.values?.slice(0, 2), [scope.restaurantId, scope.userId]);
  }
  assert.match(calls[0]?.sql ?? "", /stripe_customer_id/i);
  assert.match(calls[0]?.sql ?? "", /stripe_subscription_id/i);
  assert.match(calls[0]?.sql ?? "", /plan_type/i);
  assert.match(calls[0]?.sql ?? "", /plan_status/i);
  assert.match(calls[2]?.sql ?? "", /subscription_canceled_at = now\(\)/i);
  assert.match(calls[3]?.sql ?? "", /where id = \$1::uuid\s+and owner_id = \$2::uuid/i);
  assert.match(calls[3]?.sql ?? "", /trial_ends_at/i);
  assert.equal(status.trialEndsAt, "2026-09-27T00:00:00.000Z");
  assert.equal(status.subscriptionCanceledAt, "2026-09-26T14:00:00.000Z");
});
