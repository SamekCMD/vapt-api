import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../lib/errors.js";
import {
  createOrderBodySchema,
  createOrderHeadersSchema,
} from "./schemas.js";
import {
  createOrderRepository,
  OrderRepositoryError,
  type CreatePublicOrderRecord,
  type OrderRepository,
  type PublicOrderRecord,
} from "./repository.js";
import { createOrderService } from "./service.js";

const validBody = {
  restaurantSlug: "restaurante-teste",
  channel: "delivery" as const,
  items: [
    {
      menuItemId: "10000000-0000-4000-8000-000000000001",
      quantity: 2,
      notes: "Sem cebola",
    },
  ],
  delivery: {
    name: "Cliente Teste",
    phone: "61999999999",
    street: "Rua Um",
    number: "42",
    neighborhood: "Centro",
    paymentMode: "online" as const,
  },
};

const createdOrder: CreatePublicOrderRecord = {
  orderId: "20000000-0000-0000-0000-000000000001",
  displayId: 42,
  restaurantId: "30000000-0000-0000-0000-000000000001",
  tableSessionId: null,
  totalPrice: "51.80",
  status: "pending",
  paymentStatus: null,
  idempotentReplay: false,
};

class InMemoryOrderRepository implements OrderRepository {
  createCalls = 0;
  lastCreateInput: Parameters<OrderRepository["createPublicOrder"]>[0] | null = null;
  createResult = createdOrder;
  createError: Error | null = null;
  publicOrder: PublicOrderRecord | null = {
    ...createdOrder,
    channel: "delivery",
    tableNumber: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    items: [
      {
        menuItemId: validBody.items[0].menuItemId,
        name: "Prato",
        quantity: 2,
        unitPrice: "25.90",
        notes: "Sem cebola",
      },
    ],
  };

  async createPublicOrder(input: Parameters<OrderRepository["createPublicOrder"]>[0]) {
    this.createCalls += 1;
    this.lastCreateInput = input;
    if (this.createError) throw this.createError;
    return this.createResult;
  }

  async findPublicOrder(orderId: string, tokenHash: string) {
    if (!this.publicOrder || orderId !== this.publicOrder.orderId || tokenHash === "invalid") {
      return null;
    }
    return this.publicOrder;
  }
}

test("create order schema rejects browser-controlled financial and tenant fields", () => {
  for (const injectedField of ["totalPrice", "price", "status", "restaurantId"]) {
    const result = createOrderBodySchema.safeParse({
      ...validBody,
      [injectedField]: injectedField === "status" ? "paid" : "0.01",
    });

    assert.equal(result.success, false, `${injectedField} must be rejected`);
  }
});

test("create order schema rejects unavailable shapes before persistence", () => {
  assert.equal(
    createOrderBodySchema.safeParse({
      ...validBody,
      items: [{ ...validBody.items[0], quantity: 0 }],
    }).success,
    false,
  );
  assert.equal(
    createOrderBodySchema.safeParse({
      restaurantSlug: validBody.restaurantSlug,
      channel: "local",
      items: validBody.items,
    }).success,
    false,
  );
  assert.equal(
    createOrderBodySchema.safeParse({
      ...validBody,
      channel: "local",
      tableNumber: 5,
      delivery: validBody.delivery,
    }).success,
    false,
  );
  assert.equal(
    createOrderBodySchema.safeParse({
      restaurantSlug: validBody.restaurantSlug,
      channel: "delivery",
      items: validBody.items,
    }).success,
    false,
  );
});

test("delivery order schema accepts only explicit online or on-delivery payment modes", () => {
  assert.equal(createOrderBodySchema.safeParse(validBody).success, true);
  assert.equal(createOrderBodySchema.safeParse({
    ...validBody,
    delivery: { ...validBody.delivery, paymentMode: "on_delivery" },
  }).success, true);
  assert.equal(createOrderBodySchema.safeParse({
    ...validBody,
    delivery: { ...validBody.delivery, paymentMode: "provider_guess" },
  }).success, false);
});

test("idempotency header is mandatory and bounded", () => {
  assert.equal(createOrderHeadersSchema.safeParse({}).success, false);
  assert.equal(
    createOrderHeadersSchema.safeParse({ "idempotency-key": "order-attempt-0001" }).success,
    true,
  );
});

test("order service sends only product references and server security metadata", async () => {
  const repository = new InMemoryOrderRepository();
  const service = createOrderService(repository, "test-token-secret");

  const result = await service.createPublicOrder(validBody, "order-attempt-0001");

  assert.equal(repository.createCalls, 1);
  assert.deepEqual(repository.lastCreateInput?.items, validBody.items);
  assert.equal(repository.lastCreateInput?.restaurantSlug, validBody.restaurantSlug);
  assert.equal(repository.lastCreateInput?.channel, "delivery");
  assert.equal(repository.lastCreateInput?.delivery?.paymentMode, "online");
  assert.equal(typeof repository.lastCreateInput?.requestFingerprint, "string");
  assert.equal(typeof repository.lastCreateInput?.publicTokenHash, "string");
  assert.equal("totalPrice" in (repository.lastCreateInput ?? {}), false);
  assert.equal("restaurantId" in (repository.lastCreateInput ?? {}), false);
  assert.equal(result.totalPrice, "51.80");
  assert.ok(result.publicToken.length >= 32);
});

test("order repository uses the additive v3 RPC for explicit delivery payment mode", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return {
        async single() {
          return {
            data: {
              order_id: createdOrder.orderId,
              display_id: createdOrder.displayId,
              restaurant_id: createdOrder.restaurantId,
              table_session_id: null,
              total_price: createdOrder.totalPrice,
              status: "waiting_payment",
              payment_status: null,
              idempotent_replay: false,
            },
            error: null,
          };
        },
      };
    },
  };

  const repository = createOrderRepository(client as never);
  await repository.createPublicOrder({
    ...validBody,
    idempotencyKey: "order-attempt-0001",
    requestFingerprint: "request-fingerprint",
    publicTokenHash: "public-token-hash",
  });

  assert.equal(rpcCalls[0]?.name, "create_public_order_v3");
  assert.deepEqual(
    (rpcCalls[0]?.args.p_delivery as Record<string, unknown>).paymentMode,
    "online",
  );
});

test("unexpected order storage failures retain safe PostgREST diagnostics", async () => {
  const client = {
    rpc() {
      return {
        async single() {
          return {
            data: null,
            error: {
              code: "42804",
              message: "column status has an incompatible type",
              details: "Returned type does not match the function result",
              hint: "Add an explicit cast",
            },
          };
        },
      };
    },
  };

  const repository = createOrderRepository(client as never);

  await assert.rejects(
    repository.createPublicOrder({
      ...validBody,
      idempotencyKey: "order-attempt-0001",
      requestFingerprint: "request-fingerprint",
      publicTokenHash: "public-token-hash",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "order_storage_error");
      assert.deepEqual(error.diagnostics, {
        provider: "postgrest",
        code: "42804",
        message: "column status has an incompatible type",
        details: "Returned type does not match the function result",
        hint: "Add an explicit cast",
      });
      return true;
    },
  );
});

test("repeated idempotency key produces the same opaque public token", async () => {
  const repository = new InMemoryOrderRepository();
  const service = createOrderService(repository, "test-token-secret");

  const first = await service.createPublicOrder(validBody, "order-attempt-0001");
  repository.createResult = { ...createdOrder, idempotentReplay: true };
  const repeated = await service.createPublicOrder(validBody, "order-attempt-0001");

  assert.equal(first.publicToken, repeated.publicToken);
  assert.equal(repeated.idempotentReplay, true);
});

test("repository validation failures are exposed without leaking storage details", async () => {
  const cases = [
    ["item_unavailable", 409, "item_unavailable"],
    ["item_restaurant_mismatch", 400, "invalid_request"],
    ["idempotency_conflict", 409, "idempotency_conflict"],
  ] as const;

  for (const [repositoryCode, expectedStatus, expectedCode] of cases) {
    const repository = new InMemoryOrderRepository();
    repository.createError = new OrderRepositoryError(repositoryCode);
    const service = createOrderService(repository, "test-token-secret");

    await assert.rejects(
      service.createPublicOrder(validBody, "order-attempt-0001"),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === expectedStatus &&
        error.code === expectedCode,
    );
  }
});

test("public order lookup requires the matching opaque token", async () => {
  const repository = new InMemoryOrderRepository();
  const service = createOrderService(repository, "test-token-secret");
  const created = await service.createPublicOrder(validBody, "order-attempt-0001");

  const found = await service.getPublicOrder(created.orderId, created.publicToken);
  assert.equal(found.orderId, created.orderId);
  assert.equal(found.totalPrice, "51.80");

  repository.publicOrder = null;
  await assert.rejects(
    service.getPublicOrder(created.orderId, "wrong-token-that-is-long-enough-for-validation"),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 404 && error.code === "not_found",
  );
});
