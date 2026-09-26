import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type {
  CloseTableSessionDto,
  TableSessionDetailDto,
  TableSessionSummaryDto,
  TransferTableSessionDto,
} from "../business/contracts.js";
import {
  createTableSessionRepository,
  type TableSessionRepository,
} from "./repository.js";
import { registerTableSessionRoutes } from "./routes.js";
import { transferTableSessionBodySchema } from "./schemas.js";
import { createTableSessionService } from "./service.js";

const ownerId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";
const sessionId = "30000000-0000-4000-8000-000000000001";
const orderId = "40000000-0000-4000-8000-000000000001";

function summary(overrides: Partial<TableSessionSummaryDto> = {}): TableSessionSummaryDto {
  return {
    id: sessionId,
    restaurantId,
    tableNumber: "12",
    status: "open",
    openedAt: "2026-09-26T12:00:00.000Z",
    closedAt: null,
    sessionTotal: "9007199254740993.42",
    orderCount: 1,
    ...overrides,
  };
}

function detail(): TableSessionDetailDto {
  return {
    session: summary(),
    orders: [{
      id: orderId,
      displayId: "9007199254740993",
      totalPrice: "9007199254740993.42",
      status: "ready",
      createdAt: "2026-09-26T12:05:00.000Z",
      paymentStatus: "paid",
      paymentConfirmedAt: "2026-09-26T12:06:00.000Z",
      items: [{
        id: "50000000-0000-4000-8000-000000000001",
        productName: "Executivo",
        quantity: 1,
        unitPrice: "9007199254740993.42",
        notes: "Sem cebola",
      }],
    }],
  };
}

test("transfer schema trims and limits table numbers while rejecting tenant fields", () => {
  assert.deepEqual(
    transferTableSessionBodySchema.parse({ tableNumber: "  20  " }),
    { tableNumber: "20" },
  );
  for (const payload of [
    { tableNumber: "" },
    { tableNumber: "x".repeat(21) },
    { tableNumber: "20", restaurantId },
  ]) {
    assert.equal(transferTableSessionBodySchema.safeParse(payload).success, false);
  }
});

test("active summaries are owner-scoped and keep numeric values exact", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{
        id: sessionId,
        restaurant_id: restaurantId,
        table_number: "12",
        status: "open",
        opened_at: new Date("2026-09-26T12:00:00.000Z"),
        closed_at: null,
        session_total: "9007199254740993.42",
        order_count: "1",
      }] };
    },
  } as unknown as Database;

  const sessions = await createTableSessionRepository(database).listActiveOwnedSessions(ownerId);

  assert.deepEqual(sessions, [summary()]);
  assert.match(calls[0]?.sql ?? "", /join public\.restaurants as restaurant/i);
  assert.match(calls[0]?.sql ?? "", /restaurant\.owner_id = \$1::uuid/i);
  assert.match(calls[0]?.sql ?? "", /session_row\.status in \('open', 'check_requested'\)/i);
  assert.match(calls[0]?.sql ?? "", /coalesce\(sum\(order_row\.total_price\), 0\)::text/i);
  assert.deepEqual(calls[0]?.values, [ownerId]);
});

test("session detail is owner-scoped and returns ordered orders and items", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/from public\.table_sessions as session_row/i.test(sql)) {
        return { rows: [{
          id: sessionId,
          restaurant_id: restaurantId,
          table_number: "12",
          status: "open",
          opened_at: new Date("2026-09-26T12:00:00.000Z"),
          closed_at: null,
          session_total: "9007199254740993.42",
          order_count: "1",
        }] };
      }
      return { rows: [{
        id: orderId,
        display_id: "9007199254740993",
        total_price: "9007199254740993.42",
        status: "ready",
        created_at: new Date("2026-09-26T12:05:00.000Z"),
        payment_status: "paid",
        payment_confirmed_at: new Date("2026-09-26T12:06:00.000Z"),
        items: detail().orders[0]!.items,
      }] };
    },
  } as unknown as Database;

  const result = await createTableSessionRepository(database).getOwnedSession(ownerId, sessionId);

  assert.deepEqual(result, detail());
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.sql ?? "", /restaurant\.owner_id = \$2::uuid/i);
  assert.match(calls[1]?.sql ?? "", /order by order_row\.created_at asc/i);
  assert.match(calls[1]?.sql ?? "", /order by order_item\.created_at asc, order_item\.id asc/i);
  assert.match(calls[1]?.sql ?? "", /restaurant\.owner_id = \$2::uuid/i);
  assert.deepEqual(calls[0]?.values, [sessionId, ownerId]);
  assert.deepEqual(calls[1]?.values, [sessionId, ownerId]);
});

type TransactionOptions = {
  sessionStatus?: "open" | "check_requested" | "closed";
  ownsSession?: boolean;
  failOn?: "orders" | "session";
};

function transactionDatabase(options: TransactionOptions = {}) {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const closedAt = new Date("2026-09-26T13:00:00.000Z");
  const client = {
    async query(sql: string, values?: unknown[]) {
      const verb = sql.trim().split(/\s+/)[0]!.toUpperCase();
      events.push(verb);
      calls.push({ sql, values });
      if (/select session_row\.status/i.test(sql)) {
        return { rows: options.ownsSession === false ? [] : [{
          status: options.sessionStatus ?? "open",
          closed_at: options.sessionStatus === "closed" ? closedAt : null,
          table_number: "12",
        }] };
      }
      if (/update public\.orders as order_row/i.test(sql)) {
        if (options.failOn === "orders") throw new Error("private db detail");
        return { rows: [{ id: orderId }] };
      }
      if (/update public\.table_sessions as session_row/i.test(sql)) {
        if (options.failOn === "session") throw new Error("private db detail");
        return { rows: [{ closed_at: closedAt }] };
      }
      if (/select order_row\.id/i.test(sql)) return { rows: [{ id: orderId }] };
      return { rows: [] };
    },
    release() { events.push("RELEASE"); },
  };
  const database = {
    async query() { return { rows: [] }; },
    async connect() { events.push("CONNECT"); return client; },
  } as unknown as Database;
  return { database, calls, events };
}

test("close locks the owned session, delivers nonfinal orders, and closes atomically", async () => {
  const { database, calls, events } = transactionDatabase();
  const result = await createTableSessionRepository(database).closeOwnedSession(ownerId, sessionId);

  assert.deepEqual(result, {
    sessionId,
    status: "closed",
    closedAt: "2026-09-26T13:00:00.000Z",
    deliveredOrderIds: [orderId],
  } satisfies CloseTableSessionDto);
  assert.match(calls[1]?.sql ?? "", /restaurant\.owner_id = \$2::uuid[\s\S]*for update/i);
  const orderMutation = calls.find((call) => /update public\.orders as order_row/i.test(call.sql));
  assert.match(orderMutation?.sql ?? "", /order_row\.status in \('pending', 'paid', 'preparing', 'ready', 'waiting_payment'\)/i);
  assert.match(orderMutation?.sql ?? "", /restaurant\.owner_id = \$3::uuid/i);
  const sessionMutation = calls.find((call) => /update public\.table_sessions as session_row/i.test(call.sql));
  assert.match(sessionMutation?.sql ?? "", /restaurant\.owner_id = \$2::uuid/i);
  assert.deepEqual(events.slice(-2), ["COMMIT", "RELEASE"]);
});

test("close rolls back and sanitizes storage failures", async () => {
  const { database, events } = transactionDatabase({ failOn: "session" });
  await assert.rejects(
    () => createTableSessionRepository(database).closeOwnedSession(ownerId, sessionId),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, "internal_error");
      assert.doesNotMatch(error.message, /private db detail/i);
      return true;
    },
  );
  assert.deepEqual(events.slice(-2), ["ROLLBACK", "RELEASE"]);
});

test("repeated close is idempotent and does not mutate again", async () => {
  const { database, calls, events } = transactionDatabase({ sessionStatus: "closed" });
  const result = await createTableSessionRepository(database).closeOwnedSession(ownerId, sessionId);

  assert.equal(result?.closedAt, "2026-09-26T13:00:00.000Z");
  assert.equal(calls.some((call) => /update public\./i.test(call.sql)), false);
  assert.deepEqual(events.slice(-2), ["COMMIT", "RELEASE"]);
});

test("transfer locks an active session and updates session plus linked orders atomically", async () => {
  const { database, calls, events } = transactionDatabase();
  const result = await createTableSessionRepository(database).transferOwnedSession(
    ownerId,
    sessionId,
    "20",
  );

  assert.deepEqual(result, {
    sessionId,
    tableNumber: "20",
    updatedOrderIds: [orderId],
  } satisfies TransferTableSessionDto);
  assert.match(calls[1]?.sql ?? "", /for update/i);
  const sessionMutation = calls.find((call) => /update public\.table_sessions as session_row/i.test(call.sql));
  assert.deepEqual(sessionMutation?.values, ["20", sessionId, ownerId]);
  const orderMutation = calls.find((call) => /update public\.orders as order_row/i.test(call.sql));
  assert.deepEqual(orderMutation?.values, ["20", sessionId, ownerId]);
  assert.deepEqual(events.slice(-2), ["COMMIT", "RELEASE"]);
});

test("transfer rolls back the session update when linked order persistence fails", async () => {
  const { database, events } = transactionDatabase({ failOn: "orders" });

  await assert.rejects(
    () => createTableSessionRepository(database).transferOwnedSession(ownerId, sessionId, "20"),
    (error: unknown) => error instanceof AppError && error.code === "internal_error",
  );
  assert.deepEqual(events.slice(-2), ["ROLLBACK", "RELEASE"]);
});

test("missing ownership is 404 and a closed transfer is 409", async () => {
  const missingService = createTableSessionService(
    createTableSessionRepository(transactionDatabase({ ownsSession: false }).database),
  );
  await assert.rejects(
    () => missingService.closeOwnedSession(ownerId, sessionId),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );

  const closedService = createTableSessionService(
    createTableSessionRepository(transactionDatabase({ sessionStatus: "closed" }).database),
  );
  await assert.rejects(
    () => closedService.transferOwnedSession(ownerId, sessionId, "20"),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  );
});

test("authenticated routes derive ownership only from the session", async () => {
  const owners: string[] = [];
  const repository: TableSessionRepository = {
    async listActiveOwnedSessions(userId) { owners.push(userId); return [summary()]; },
    async getOwnedSession(userId) { owners.push(userId); return detail(); },
    async closeOwnedSession(userId) {
      owners.push(userId);
      return { sessionId, status: "closed", closedAt: "2026-09-26T13:00:00.000Z", deliveredOrderIds: [orderId] };
    },
    async transferOwnedSession(userId, _sessionId, tableNumber) {
      owners.push(userId);
      return { sessionId, tableNumber, updatedOrderIds: [orderId] };
    },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({ userId: ownerId, email: null, role: "authenticated" }));
  registerErrorHandler(app);
  await registerTableSessionRoutes(app, repository);

  assert.equal((await app.inject({ method: "GET", url: "/restaurants/me/table-sessions" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/restaurants/me/table-sessions/${sessionId}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/restaurants/me/table-sessions/${sessionId}/close` })).statusCode, 200);
  assert.equal((await app.inject({
    method: "POST",
    url: `/restaurants/me/table-sessions/${sessionId}/transfer`,
    payload: { tableNumber: "20" },
  })).statusCode, 200);
  assert.deepEqual(owners, [ownerId, ownerId, ownerId, ownerId]);
  await app.close();
});
