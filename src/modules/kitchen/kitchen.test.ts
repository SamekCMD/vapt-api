import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { KitchenOrderDto, KitchenOrderStatus } from "../business/contracts.js";
import { createKitchenRepository, type KitchenRepository } from "./repository.js";
import { registerKitchenRoutes } from "./routes.js";
import { updateKitchenOrderStatusBodySchema } from "./schemas.js";
import { createKitchenService } from "./service.js";

const ownerId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";
const orderId = "30000000-0000-4000-8000-000000000001";

function rawOrder(status: KitchenOrderStatus = "pending") {
  return {
    id: orderId,
    display_id: "9007199254740993",
    restaurant_id: restaurantId,
    table_number: "12",
    total_price: "59.80",
    status,
    payment_status: "paid",
    order_channel: "local",
    created_at: new Date("2026-09-26T12:00:00.000Z"),
    updated_at: new Date("2026-09-26T12:05:00.000Z"),
    items: [{
      id: "40000000-0000-4000-8000-000000000001",
      productName: "X-Burguer",
      quantity: 2,
      unitPrice: "29.90",
      notes: "Sem cebola",
    }],
  };
}

function orderDto(status: KitchenOrderStatus = "pending"): KitchenOrderDto {
  return {
    id: orderId,
    displayId: "9007199254740993",
    restaurantId,
    tableNumber: "12",
    totalPrice: "59.80",
    status,
    channel: "local",
    paymentStatus: "paid",
    createdAt: "2026-09-26T12:00:00.000Z",
    updatedAt: "2026-09-26T12:05:00.000Z",
    items: [{
      id: "40000000-0000-4000-8000-000000000001",
      productName: "X-Burguer",
      quantity: 2,
      unitPrice: "29.90",
      notes: "Sem cebola",
    }],
  };
}

test("status schema accepts only kitchen targets and rejects tenant fields", () => {
  for (const status of ["preparing", "ready", "delivered"]) {
    assert.equal(updateKitchenOrderStatusBodySchema.safeParse({ status }).success, true);
  }
  for (const payload of [
    { status: "pending" },
    { status: "ready", ownerId },
    { status: "ready", restaurantId },
  ]) {
    assert.equal(updateKitchenOrderStatusBodySchema.safeParse(payload).success, false);
  }
});

test("active queue is owner-scoped, includes ordered items, and sorts newest first", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [rawOrder()] };
    },
  } as unknown as Database;

  const orders = await createKitchenRepository(database).listActiveOwnedOrders(ownerId);

  assert.deepEqual(orders, [orderDto()]);
  assert.match(calls[0]?.sql ?? "", /join public\.restaurants as restaurant/i);
  assert.match(calls[0]?.sql ?? "", /restaurant\.owner_id = \$1::uuid/i);
  assert.match(calls[0]?.sql ?? "", /order_row\.status in \('paid', 'pending', 'preparing', 'ready'\)/i);
  assert.match(calls[0]?.sql ?? "", /order by order_row\.created_at desc/i);
  assert.match(calls[0]?.sql ?? "", /order by order_item\.created_at asc, order_item\.id asc/i);
  assert.deepEqual(calls[0]?.values, [ownerId]);
});

function transitionDatabase(
  currentStatus: KitchenOrderStatus,
  nextRowStatus = currentStatus,
  ownsOrder = true,
) {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      events.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
      calls.push({ sql, values });
      if (/select order_row\.status/i.test(sql)) {
        return { rows: ownsOrder ? [{ status: currentStatus }] : [] };
      }
      if (/from public\.orders as order_row/i.test(sql)) return { rows: [rawOrder(nextRowStatus)] };
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

test("valid transition locks the owned order and updates it in the same transaction", async () => {
  const { database, calls, events } = transitionDatabase("pending", "preparing");
  const service = createKitchenService(createKitchenRepository(database));

  const updated = await service.updateOwnedOrderStatus(ownerId, orderId, "preparing");

  assert.deepEqual(updated, orderDto("preparing"));
  assert.match(calls[1]?.sql ?? "", /where order_row\.id = \$1::uuid[\s\S]*restaurant\.owner_id = \$2::uuid[\s\S]*for update/i);
  const mutation = calls.find((call) => /update public\.orders as order_row/i.test(call.sql));
  assert.match(mutation?.sql ?? "", /from public\.restaurants as restaurant/i);
  assert.match(mutation?.sql ?? "", /restaurant\.owner_id = \$3::uuid/i);
  assert.deepEqual(mutation?.values, ["preparing", orderId, ownerId]);
  assert.equal(events.at(-2), "COMMIT");
  assert.equal(events.at(-1), "RELEASE");
});

test("invalid transitions return 409 and roll back without mutating", async () => {
  const { database, calls, events } = transitionDatabase("pending");
  const service = createKitchenService(createKitchenRepository(database));

  await assert.rejects(
    () => service.updateOwnedOrderStatus(ownerId, orderId, "ready"),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "invalid_order_transition");
      return true;
    },
  );
  assert.equal(calls.some((call) => /update public\.orders as order_row/i.test(call.sql)), false);
  assert.equal(events.at(-2), "ROLLBACK");
  assert.equal(events.at(-1), "RELEASE");
});

test("same-state retry is idempotent and does not issue an update", async () => {
  const { database, calls, events } = transitionDatabase("preparing", "preparing");
  const service = createKitchenService(createKitchenRepository(database));

  const retried = await service.updateOwnedOrderStatus(ownerId, orderId, "preparing");

  assert.deepEqual(retried, orderDto("preparing"));
  assert.equal(calls.some((call) => /update public\.orders as order_row/i.test(call.sql)), false);
  assert.equal(events.at(-2), "COMMIT");
});

test("another owner's order is indistinguishable from a missing order", async () => {
  const { database } = transitionDatabase("pending", "pending", false);
  const service = createKitchenService(createKitchenRepository(database));

  await assert.rejects(
    () => service.updateOwnedOrderStatus(ownerId, orderId, "preparing"),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("concurrent retries serialize into one transition plus one idempotent result", async () => {
  let status: KitchenOrderStatus = "pending";
  let updates = 0;
  let queue = Promise.resolve();
  const repository: KitchenRepository = {
    async listActiveOwnedOrders() { return []; },
    async updateOwnedOrderStatus(_userId, _orderId, target, validateCurrent) {
      const operation = queue.then(async () => {
        validateCurrent(status);
        if (status !== target) {
          updates += 1;
          status = target;
        }
        return orderDto(status);
      });
      queue = operation.then(() => undefined);
      return operation;
    },
  };
  const service = createKitchenService(repository);

  const results = await Promise.all([
    service.updateOwnedOrderStatus(ownerId, orderId, "preparing"),
    service.updateOwnedOrderStatus(ownerId, orderId, "preparing"),
  ]);

  assert.equal(updates, 1);
  assert.deepEqual(results.map((order) => order.status), ["preparing", "preparing"]);
});

test("authenticated routes derive owner from the session", async () => {
  const owners: string[] = [];
  const repository: KitchenRepository = {
    async listActiveOwnedOrders(userId) { owners.push(userId); return [orderDto()]; },
    async updateOwnedOrderStatus(userId, _orderId, target, validateCurrent) {
      owners.push(userId);
      validateCurrent("pending");
      return orderDto(target);
    },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({ userId: ownerId, email: null, role: "authenticated" }));
  registerErrorHandler(app);
  await registerKitchenRoutes(app, repository);

  const list = await app.inject({ method: "GET", url: "/restaurants/me/kitchen/orders" });
  assert.equal(list.statusCode, 200);
  const patch = await app.inject({
    method: "PATCH",
    url: `/restaurants/me/kitchen/orders/${orderId}/status`,
    payload: { status: "preparing" },
  });
  assert.equal(patch.statusCode, 200);
  assert.deepEqual(owners, [ownerId, ownerId]);
  await app.close();
});
