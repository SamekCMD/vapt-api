import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { OverviewDto } from "../business/contracts.js";
import { createOverviewRepository, type OverviewRepository } from "./repository.js";
import { registerOverviewRoutes } from "./routes.js";
import { overviewQuerySchema } from "./schemas.js";
import { createOverviewService } from "./service.js";

const ownerId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";

function overview(period: "day" | "week" | "month" = "week"): OverviewDto {
  return {
    period,
    periodStart: "2026-09-20T00:00:00.000Z",
    restaurant: {
      id: restaurantId,
      name: "Vapt Burger",
      paymentMode: "open_tab",
      onboardingCompleted: true,
      deliveryEnabled: false,
    },
    orders: [{
      id: "30000000-0000-4000-8000-000000000001",
      displayId: "9007199254740993",
      totalPrice: "59.80",
      status: "delivered",
      createdAt: "2026-09-25T12:00:00.000Z",
      updatedAt: "2026-09-25T12:20:00.000Z",
      items: [{ productName: "Executivo", quantity: 2, unitPrice: "29.90" }],
    }],
    feedback: [],
  };
}

test("overview query accepts only the three planned periods and rejects tenant fields", () => {
  for (const period of ["day", "week", "month"]) {
    assert.equal(overviewQuerySchema.safeParse({ period }).success, true);
  }
  for (const query of [
    { period: "year" },
    { period: "week", ownerId },
    { period: "week", restaurantId },
  ]) {
    assert.equal(overviewQuerySchema.safeParse(query).success, false);
  }
});

test("period boundaries are calculated once in UTC on the server", async () => {
  const calls: Array<{ ownerId: string; periodStart: Date }> = [];
  const repository: OverviewRepository = {
    async getOwnedOverview(userId, periodStart) {
      calls.push({ ownerId: userId, periodStart });
      return overview();
    },
  };
  const service = createOverviewService(
    repository,
    () => new Date("2026-09-23T18:45:00.000Z"),
  );

  assert.equal((await service.getOwnedOverview(ownerId, "day")).periodStart, "2026-09-23T00:00:00.000Z");
  assert.equal((await service.getOwnedOverview(ownerId, "week")).periodStart, "2026-09-20T00:00:00.000Z");
  assert.equal((await service.getOwnedOverview(ownerId, "month")).periodStart, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(calls.map((call) => call.periodStart.toISOString()), [
    "2026-09-23T00:00:00.000Z",
    "2026-09-20T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
  ]);
});

test("repository scopes every dataset to the owner and preserves edge serialization", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/from public\.restaurants as restaurant/i.test(sql) && !/join public\.restaurants/i.test(sql)) {
        return { rows: [{
          id: restaurantId,
          name: "Vapt Burger",
          payment_mode: "open_tab",
          onboarding_completed: true,
          delivery_enabled: false,
        }] };
      }
      if (/from public\.orders as order_row/i.test(sql)) {
        return { rows: [{
          id: "30000000-0000-4000-8000-000000000001",
          display_id: "9007199254740993",
          total_price: "59.80",
          status: "delivered",
          created_at: new Date("2026-09-25T12:00:00.000Z"),
          updated_at: new Date("2026-09-25T12:20:00.000Z"),
          items: [{ productName: "Executivo", quantity: 2, unitPrice: "29.90" }],
        }] };
      }
      return { rows: [] };
    },
    async connect() { throw new Error("not used"); },
  } as unknown as Database;
  const periodStart = new Date("2026-09-20T00:00:00.000Z");

  const result = await createOverviewRepository(database).getOwnedOverview(ownerId, periodStart);

  assert.deepEqual(result, {
    restaurant: overview().restaurant,
    orders: overview().orders,
    feedback: [],
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.sql, /restaurant\.owner_id = \$1::uuid/i);
  }
  assert.deepEqual(calls[1]?.values, [ownerId, periodStart]);
  assert.deepEqual(calls[2]?.values, [ownerId, periodStart]);
  assert.match(calls[1]?.sql ?? "", /order by order_item\.created_at asc, order_item\.id asc/i);
});

test("overview preserves rating boundaries, arrays, and null feedback fields", async () => {
  const database = {
    async query(sql: string) {
      if (/from public\.restaurants as restaurant/i.test(sql) && !/join public\.restaurants/i.test(sql)) {
        return { rows: [{
          id: restaurantId,
          name: "Vapt Burger",
          payment_mode: "open_tab",
          onboarding_completed: true,
          delivery_enabled: false,
        }] };
      }
      if (/from public\.orders as order_row/i.test(sql)) return { rows: [] };
      return { rows: [
        {
          order_id: "30000000-0000-4000-8000-000000000001",
          restaurant_id: restaurantId,
          rating: 1,
          reasons: null,
          comment: null,
          created_at: new Date("2026-09-25T12:00:00.000Z"),
        },
        {
          order_id: "30000000-0000-4000-8000-000000000002",
          restaurant_id: restaurantId,
          rating: 5,
          reasons: ["Muito bom"],
          comment: "Rápido",
          created_at: new Date("2026-09-25T13:00:00.000Z"),
        },
      ] };
    },
    async connect() { throw new Error("not used"); },
  } as unknown as Database;

  const result = await createOverviewRepository(database).getOwnedOverview(
    ownerId,
    new Date("2026-09-20T00:00:00.000Z"),
  );

  assert.deepEqual(result?.feedback.map(({ rating, reasons, comment }) => ({ rating, reasons, comment })), [
    { rating: 1, reasons: [], comment: null },
    { rating: 5, reasons: ["Muito bom"], comment: "Rápido" },
  ]);
});

test("another owner is indistinguishable from a missing restaurant", async () => {
  const database = {
    async query() { return { rows: [] }; },
    async connect() { throw new Error("not used"); },
  } as unknown as Database;
  const service = createOverviewService(createOverviewRepository(database));

  await assert.rejects(
    () => service.getOwnedOverview(ownerId, "week"),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

test("authenticated overview route derives ownership from the session", async () => {
  const owners: string[] = [];
  const repository: OverviewRepository = {
    async getOwnedOverview(userId) { owners.push(userId); return overview(); },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({ userId: ownerId, email: null, role: "authenticated" }));
  registerErrorHandler(app);
  await registerOverviewRoutes(app, repository, () => new Date("2026-09-23T18:45:00.000Z"));

  const response = await app.inject({ method: "GET", url: "/restaurants/me/overview?period=week" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(owners, [ownerId]);
  assert.equal(response.json().periodStart, "2026-09-20T00:00:00.000Z");
  await app.close();
});
