import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { OrderFeedbackDto } from "../business/contracts.js";
import type { FeedbackRepository } from "../feedback/repository.js";
import type { OrderService } from "../orders/service.js";
import {
  createPushSubscriptionRepository,
  type PushSubscriptionRepository,
} from "./repository.js";
import { registerIngestRoutes } from "./routes.js";
import { pushSubscriptionBodySchema } from "./schemas.js";

const userId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";
const orderId = "30000000-0000-4000-8000-000000000001";
const orderToken = "public-token-that-is-at-least-32-characters";
const subscription = { endpoint: "https://push.example/subscription", keys: { auth: "auth" } };

function pushBody() {
  return {
    subscription,
    endpoint: "https://push.example/subscription",
    origin: "https://app.vapt.test",
    user_agent: "Vapt test browser",
  };
}

function feedback(): OrderFeedbackDto {
  return {
    orderId,
    restaurantId,
    rating: 5,
    reasons: ["Muito bom"],
    comment: null,
    createdAt: "2026-09-26T13:00:00.000Z",
  };
}

async function buildRouteApp(input: {
  pushSubscriptions: PushSubscriptionRepository;
  feedbackRepository?: FeedbackRepository;
  publicOrders?: Pick<OrderService, "getPublicOrder">;
}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerAuthDecorator(app, async (headers) =>
    headers.cookie?.includes("valid-session")
      ? { userId, email: "owner@example.com", role: "authenticated" }
      : null,
  );
  await registerIngestRoutes(app, {
    pushSubscriptions: input.pushSubscriptions,
    feedbackRepository: input.feedbackRepository ?? {
      async upsertOrderFeedback() { return feedback(); },
    },
    publicOrders: input.publicOrders ?? {
      async getPublicOrder() {
        return {
          orderId,
          displayId: "42",
          restaurantId,
          tableSessionId: null,
          totalPrice: "29.90",
          status: "delivered",
          paymentStatus: "paid",
          idempotentReplay: false,
          channel: "local",
          tableNumber: "7",
          createdAt: "2026-09-26T12:00:00.000Z",
          items: [],
        };
      },
    },
  });
  return app;
}

test("push subscription input cannot select a restaurant or timestamp", () => {
  assert.equal(pushSubscriptionBodySchema.safeParse(pushBody()).success, true);
  assert.equal(pushSubscriptionBodySchema.safeParse({
    ...pushBody(),
    restaurant_id: restaurantId,
  }).success, false);
  assert.equal(pushSubscriptionBodySchema.safeParse({
    ...pushBody(),
    created_at: "2026-09-26T00:00:00.000Z",
  }).success, false);
});

test("push repository derives the restaurant from owner and upserts by endpoint", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ restaurant_id: restaurantId, endpoint: pushBody().endpoint }] };
    },
  } as unknown as Database;

  const result = await createPushSubscriptionRepository(database).upsertOwnedSubscription(
    userId,
    pushBody(),
  );

  assert.deepEqual(result, {
    restaurantId,
    endpoint: pushBody().endpoint,
    status: "subscribed",
  });
  assert.match(calls[0]?.sql ?? "", /insert into public\.push_subscriptions/i);
  assert.match(calls[0]?.sql ?? "", /from public\.restaurants r/i);
  assert.match(calls[0]?.sql ?? "", /r\.owner_id = \$1::uuid/i);
  assert.match(calls[0]?.sql ?? "", /on conflict \(endpoint\) do update/i);
  assert.deepEqual(calls[0]?.values, [
    userId,
    pushBody().endpoint,
    subscription,
    pushBody().origin,
    pushBody().user_agent,
  ]);
});

test("push subscription route requires a Better Auth session", async () => {
  let writes = 0;
  const app = await buildRouteApp({
    pushSubscriptions: {
      async upsertOwnedSubscription() {
        writes += 1;
        return { restaurantId, endpoint: pushBody().endpoint, status: "subscribed" };
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/ingest/push-subscription",
    payload: pushBody(),
  });

  assert.equal(response.statusCode, 401);
  assert.equal(writes, 0);
  await app.close();
});

test("push subscription route passes only the authenticated owner to persistence", async () => {
  const writes: unknown[] = [];
  const app = await buildRouteApp({
    pushSubscriptions: {
      async upsertOwnedSubscription(...args: unknown[]) {
        writes.push(args);
        return { restaurantId, endpoint: pushBody().endpoint, status: "subscribed" };
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/ingest/push-subscription",
    headers: { cookie: "valid-session" },
    payload: pushBody(),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(writes, [[userId, pushBody()]]);
  await app.close();
});

test("legacy feedback ingest delegates to token-authenticated feedback persistence", async () => {
  const orderLookups: unknown[] = [];
  const writes: unknown[] = [];
  const app = await buildRouteApp({
    pushSubscriptions: {
      async upsertOwnedSubscription() {
        return { restaurantId, endpoint: pushBody().endpoint, status: "subscribed" };
      },
    },
    publicOrders: {
      async getPublicOrder(...args: unknown[]) {
        orderLookups.push(args);
        return {
          orderId,
          displayId: "42",
          restaurantId,
          tableSessionId: null,
          totalPrice: "29.90",
          status: "delivered",
          paymentStatus: "paid",
          idempotentReplay: false,
          channel: "local",
          tableNumber: "7",
          createdAt: "2026-09-26T12:00:00.000Z",
          items: [],
        };
      },
    },
    feedbackRepository: {
      async upsertOrderFeedback(input) {
        writes.push(input);
        return feedback();
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/ingest/order-feedback",
    headers: { "x-vapt-order-token": orderToken },
    payload: {
      order_id: orderId,
      restaurant_id: "90000000-0000-4000-8000-000000000009",
      rating: 5,
      reasons: ["Muito bom"],
      comment: null,
      created_at: "1999-01-01T00:00:00.000Z",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(orderLookups, [[orderId, orderToken]]);
  assert.deepEqual(writes, [{
    orderId,
    restaurantId,
    rating: 5,
    reasons: ["Muito bom"],
    comment: null,
  }]);
  await app.close();
});
