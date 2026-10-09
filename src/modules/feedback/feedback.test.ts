import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { OrderFeedbackDto } from "../business/contracts.js";
import type { OrderService } from "../orders/service.js";
import { createFeedbackRepository, type FeedbackRepository } from "./repository.js";
import { registerFeedbackRoutes } from "./routes.js";
import { feedbackBodySchema } from "./schemas.js";
import { createFeedbackService } from "./service.js";

const orderId = "30000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";
const token = "public-token-that-is-at-least-32-characters";

const publicOrder = {
  orderId,
  displayId: "42",
  restaurantId,
  tableSessionId: null,
  totalPrice: "29.90",
  status: "delivered",
  paymentStatus: "paid",
  idempotentReplay: false,
  channel: "local" as const,
  tableNumber: "7",
  createdAt: "2026-09-26T12:00:00.000Z",
  items: [],
};

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

test("feedback body accepts only rating, reasons, and comment", () => {
  assert.equal(feedbackBodySchema.safeParse({ rating: 1, reasons: [], comment: null }).success, true);
  assert.equal(feedbackBodySchema.safeParse({ rating: 5, reasons: ["Muito bom"] }).success, true);
  for (const body of [
    { rating: 0 },
    { rating: 6 },
    { rating: 5, orderId },
    { rating: 5, restaurantId },
    { rating: 5, createdAt: "2026-09-26T00:00:00.000Z" },
  ]) {
    assert.equal(feedbackBodySchema.safeParse(body).success, false);
  }
});

test("feedback authorizes with the order token and persists server-derived identity", async () => {
  const lookups: unknown[][] = [];
  const writes: unknown[] = [];
  const orderService = {
    async getPublicOrder(...args: unknown[]) { lookups.push(args); return publicOrder; },
  } as Pick<OrderService, "getPublicOrder">;
  const repository: FeedbackRepository = {
    async upsertOrderFeedback(input) { writes.push(input); return feedback(); },
  };
  const service = createFeedbackService(repository, orderService);

  const result = await service.submitOrderFeedback(orderId, token, {
    rating: 5,
    reasons: ["Muito bom"],
    comment: null,
  });

  assert.deepEqual(result, feedback());
  assert.deepEqual(lookups, [[orderId, token]]);
  assert.deepEqual(writes, [{
    orderId,
    restaurantId,
    rating: 5,
    reasons: ["Muito bom"],
    comment: null,
  }]);
});

test("wrong tokens return 401 and never write feedback", async () => {
  let writes = 0;
  const service = createFeedbackService(
    { async upsertOrderFeedback() { writes += 1; return feedback(); } },
    {
      async getPublicOrder() {
        throw new AppError(404, "not_found", "Order not found");
      },
    },
  );

  await assert.rejects(
    () => service.submitOrderFeedback(orderId, token, { rating: 5, reasons: [], comment: null }),
    (error: unknown) => error instanceof AppError && error.statusCode === 401,
  );
  assert.equal(writes, 0);
});

test("repository performs an idempotent upsert and sanitizes its output", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{
        order_id: orderId,
        restaurant_id: restaurantId,
        rating: 5,
        reasons: ["Muito bom"],
        comment: null,
        created_at: new Date("2026-09-26T13:00:00.000Z"),
      }] };
    },
  } as unknown as Database;

  const result = await createFeedbackRepository(database).upsertOrderFeedback({
    orderId,
    restaurantId,
    rating: 5,
    reasons: ["Muito bom"],
    comment: null,
  });

  assert.deepEqual(result, feedback());
  assert.match(calls[0]?.sql ?? "", /on conflict \(order_id\) do update/i);
  assert.match(calls[0]?.sql ?? "", /restaurant_id = excluded\.restaurant_id/i);
  assert.deepEqual(calls[0]?.values, [orderId, restaurantId, 5, ["Muito bom"], null]);
});

test("public feedback route returns 401 when the order token is absent", async () => {
  let writes = 0;
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerFeedbackRoutes(
    app,
    { async upsertOrderFeedback() { writes += 1; return feedback(); } },
    { async getPublicOrder() { return publicOrder; } },
  );

  const response = await app.inject({
    method: "PUT",
    url: `/public/orders/${orderId}/feedback`,
    payload: { rating: 5, reasons: [], comment: null },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(writes, 0);
  await app.close();
});
