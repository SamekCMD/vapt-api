import assert from "node:assert/strict";
import test from "node:test";

import type { PaymentProvider } from "./provider.js";
import type {
  ApplyPaymentTransitionInput,
  CreatePaymentTransactionInput,
  PaymentRepository,
  PaymentTransactionRecord,
} from "./repository.js";
import {
  DuplicatePaymentProviderError,
  PaymentProviderNotFoundError,
  createPaymentProviderRegistry,
} from "./registry.js";
import {
  InvalidPaymentTransitionError,
  assertPaymentTransition,
  isPaymentTransitionAllowed,
} from "./state-machine.js";
import {
  PaymentIdempotencyConflictError,
  createPaymentService,
} from "./service.js";
import { PAYMENT_STATUSES, type PaymentStatus } from "./types.js";

function createProvider(code: PaymentProvider["code"]): PaymentProvider {
  return {
    code,
    getCapabilities: () => ({
      onlineCheckout: false,
      webhooks: false,
      cancellation: false,
      fullRefunds: false,
      partialRefunds: false,
      oauthConnection: false,
    }),
    createPayment: async (input) => ({
      transactionId: input.transactionId,
      provider: code,
      status: "pending",
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      externalPaymentId: null,
      providerStatus: null,
      checkoutUrl: null,
      expiresAt: null,
      occurredAt: new Date().toISOString(),
      metadata: {},
    }),
    getPaymentStatus: async (input) => ({
      transactionId: input.transactionId,
      provider: code,
      status: "pending",
      amount: input.amount,
      paymentMethod: null,
      externalPaymentId: input.externalPaymentId,
      providerStatus: null,
      occurredAt: new Date().toISOString(),
      metadata: {},
    }),
  };
}

test("payment registry resolves a known provider", () => {
  const manual = createProvider("manual");
  const registry = createPaymentProviderRegistry([manual]);

  assert.equal(registry.get("manual"), manual);
  assert.equal(registry.has("manual"), true);
  assert.deepEqual(registry.codes(), ["manual"]);
});

test("payment registry rejects duplicate providers", () => {
  const registry = createPaymentProviderRegistry([createProvider("manual")]);

  assert.throws(
    () => registry.register(createProvider("manual")),
    (error: unknown) =>
      error instanceof DuplicatePaymentProviderError && error.providerCode === "manual",
  );
});

test("payment registry rejects missing providers", () => {
  const registry = createPaymentProviderRegistry();

  assert.throws(
    () => registry.get("mercado_pago"),
    (error: unknown) =>
      error instanceof PaymentProviderNotFoundError && error.providerCode === "mercado_pago",
  );
});

const validTransitions = new Set<string>([
  "created:pending",
  "created:processing",
  "created:paid",
  "created:failed",
  "created:cancelled",
  "pending:processing",
  "pending:paid",
  "pending:failed",
  "pending:cancelled",
  "processing:pending",
  "processing:paid",
  "processing:failed",
  "processing:cancelled",
  "paid:refunded",
]);

for (const current of PAYMENT_STATUSES) {
  for (const next of PAYMENT_STATUSES) {
    const transition = `${current}:${next}`;
    const expected = current === next || validTransitions.has(transition);

    test(`payment transition ${transition} is ${expected ? "accepted" : "rejected"}`, () => {
      assert.equal(isPaymentTransitionAllowed(current, next), expected);

      if (expected) {
        assert.doesNotThrow(() => assertPaymentTransition(current, next));
        return;
      }

      assert.throws(
        () => assertPaymentTransition(current, next),
        (error: unknown) =>
          error instanceof InvalidPaymentTransitionError &&
          error.currentStatus === current &&
          error.nextStatus === next,
      );
    });
  }
}

test("all documented payment statuses are covered by the transition matrix", () => {
  const statuses = new Set<PaymentStatus>(PAYMENT_STATUSES);

  assert.deepEqual(statuses, new Set([
    "created",
    "pending",
    "processing",
    "paid",
    "failed",
    "cancelled",
    "refunded",
  ]));
});

class InMemoryPaymentRepository implements PaymentRepository {
  readonly transactions = new Map<string, PaymentTransactionRecord>();
  readonly transitions: ApplyPaymentTransitionInput[] = [];
  createCount = 0;

  async findOrderForManualPayment() {
    return null;
  }

  async findActiveProviderAccount() {
    return null;
  }

  async findTransactionById(transactionId: string) {
    return this.transactions.get(transactionId) ?? null;
  }

  async findTransactionByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    return [...this.transactions.values()].find(
      (transaction) =>
        transaction.restaurantId === restaurantId &&
        transaction.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async createTransaction(input: CreatePaymentTransactionInput) {
    this.createCount += 1;
    const transaction: PaymentTransactionRecord = {
      id: `transaction-${this.createCount}`,
      restaurantId: input.restaurantId,
      orderId: input.orderId,
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      externalPaymentId: null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      amount: input.amount,
      status: "created",
      providerStatus: null,
      paymentMethod: input.paymentMethod,
      processingMode: input.processingMode,
      providerPayload: {},
      manuallyConfirmedBy: input.manuallyConfirmedBy ?? null,
      checkoutUrl: null,
      expiresAt: null,
      version: 1,
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  async applyPaymentTransition(input: ApplyPaymentTransitionInput) {
    this.transitions.push(input);
    const current = this.transactions.get(input.transactionId);
    assert.ok(current);
    const updated: PaymentTransactionRecord = {
      ...current,
      status: input.newStatus,
      providerStatus: input.providerStatus ?? current.providerStatus,
      externalPaymentId: input.externalPaymentId ?? current.externalPaymentId,
      checkoutUrl: input.checkoutUrl ?? current.checkoutUrl,
      expiresAt: input.expiresAt ?? current.expiresAt,
      providerPayload: input.providerPayload,
      version: current.version + (current.status === input.newStatus ? 0 : 1),
    };
    this.transactions.set(updated.id, updated);
    return updated;
  }

  async reserveWebhookEvent() {
    return { duplicate: false };
  }

  async markWebhookEvent() {}

  async claimEffects() {
    return [];
  }

  async completeEffect() {}

  async failEffect() {}

  async releaseOrderToProduction() {}

  async countPendingEffects() {
    return 0;
  }
}

test("payment service creates one transaction and applies provider result atomically", async () => {
  let providerCalls = 0;
  const provider = createProvider("manual");
  provider.createPayment = async (input) => {
    providerCalls += 1;
    return {
      transactionId: input.transactionId,
      provider: "manual",
      status: "paid",
      amount: input.amount,
      paymentMethod: "cash",
      externalPaymentId: null,
      providerStatus: "confirmed_by_operator",
      checkoutUrl: new URL("https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-1"),
      expiresAt: "2026-07-25T12:31:00.000Z",
      metadata: { preferenceId: "preference-1" },
      occurredAt: "2026-07-25T12:01:00.000Z",
    };
  };
  const repository = new InMemoryPaymentRepository();
  const service = createPaymentService(
    createPaymentProviderRegistry([provider]),
    repository,
  );

  const result = await service.startPayment({
    restaurantId: "restaurant-1",
    orderId: "order-1",
    provider: "manual",
    environment: "sandbox",
    amount: { amount: "25.90", currency: "BRL" },
    paymentMethod: "cash",
    processingMode: "manual",
    description: "Pedido 42",
    idempotencyKey: "checkout-1",
    requestFingerprint: "fingerprint-1",
    returnUrls: null,
  });

  assert.equal(providerCalls, 1);
  assert.equal(repository.createCount, 1);
  assert.equal(repository.transitions.length, 1);
  assert.deepEqual(repository.transitions[0], {
    transactionId: "transaction-1",
    expectedVersion: 1,
    newStatus: "paid",
    providerStatus: "confirmed_by_operator",
    externalPaymentId: null,
    transitionedAt: "2026-07-25T12:01:00.000Z",
    checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-1",
    expiresAt: "2026-07-25T12:31:00.000Z",
    providerPayload: { preferenceId: "preference-1" },
    effectTypes: ["release_order_to_kitchen"],
  });
  assert.equal(result.status, "paid");
  assert.equal(result.version, 2);
  assert.equal(result.checkoutUrl, "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-1");
  assert.equal(result.expiresAt, "2026-07-25T12:31:00.000Z");
  assert.deepEqual(result.providerPayload, { preferenceId: "preference-1" });
});

test("payment service reuses an idempotent transaction without calling the provider", async () => {
  let providerCalls = 0;
  const provider = createProvider("manual");
  provider.createPayment = async (input) => {
    providerCalls += 1;
    return createProvider("manual").createPayment(input);
  };
  const repository = new InMemoryPaymentRepository();
  await repository.createTransaction({
    restaurantId: "restaurant-1",
    orderId: "order-1",
    providerAccountId: null,
    provider: "manual",
    idempotencyKey: "checkout-1",
    requestFingerprint: "fingerprint-1",
    amount: { amount: "25.90", currency: "BRL" },
    paymentMethod: "cash",
    processingMode: "manual",
  });
  const service = createPaymentService(createPaymentProviderRegistry([provider]), repository);

  const result = await service.startPayment({
    restaurantId: "restaurant-1",
    orderId: "order-1",
    provider: "manual",
    environment: "sandbox",
    amount: { amount: "25.90", currency: "BRL" },
    paymentMethod: "cash",
    processingMode: "manual",
    description: "Pedido 42",
    idempotencyKey: "checkout-1",
    requestFingerprint: "fingerprint-1",
    returnUrls: null,
  });

  assert.equal(providerCalls, 0);
  assert.equal(repository.createCount, 1);
  assert.equal(result.id, "transaction-1");
});

test("payment service rejects reuse of an idempotency key with a different payload", async () => {
  const repository = new InMemoryPaymentRepository();
  await repository.createTransaction({
    restaurantId: "restaurant-1",
    orderId: "order-1",
    providerAccountId: null,
    provider: "manual",
    idempotencyKey: "checkout-1",
    requestFingerprint: "fingerprint-original",
    amount: { amount: "25.90", currency: "BRL" },
    paymentMethod: "cash",
    processingMode: "manual",
  });
  const service = createPaymentService(
    createPaymentProviderRegistry([createProvider("manual")]),
    repository,
  );

  await assert.rejects(
    service.startPayment({
      restaurantId: "restaurant-1",
      orderId: "order-1",
      provider: "manual",
      environment: "sandbox",
      amount: { amount: "30.00", currency: "BRL" },
      paymentMethod: "cash",
      processingMode: "manual",
      description: "Pedido alterado",
      idempotencyKey: "checkout-1",
      requestFingerprint: "fingerprint-altered",
      returnUrls: null,
    }),
    PaymentIdempotencyConflictError,
  );
});
