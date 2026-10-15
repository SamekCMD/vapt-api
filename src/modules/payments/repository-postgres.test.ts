import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { createPaymentRepository, PaymentTransactionConflictError } from "./repository.js";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const orderId = "20000000-0000-4000-8000-000000000002";
const transactionId = "30000000-0000-4000-8000-000000000003";
const accountId = "40000000-0000-4000-8000-000000000004";

type QueryCall = { sql: string; values: unknown[] | undefined };

function scriptedDatabase(
  responses: Array<{ rows: unknown[] } | Error>,
  calls: QueryCall[],
): Queryable {
  return {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("unexpected query");
      return response;
    },
  } as unknown as Queryable;
}

const rawTransaction = {
  id: transactionId,
  restaurant_id: restaurantId,
  order_id: orderId,
  provider_account_id: accountId,
  provider: "mercado_pago",
  external_payment_id: null,
  idempotency_key: "payment-attempt-0001",
  request_fingerprint: "fingerprint",
  amount: "51.80",
  currency: "BRL",
  status: "created",
  provider_status: null,
  payment_method: "pix",
  processing_mode: "online",
  manually_confirmed_by: null,
  provider_payload: { preferenceId: "pref-1" },
  checkout_url: "https://checkout.example.com/pref-1",
  expires_at: new Date("2026-09-25T13:00:00.000Z"),
  version: 1,
  created_at: new Date("2026-09-25T12:00:00.000Z"),
  updated_at: new Date("2026-09-25T12:00:00.000Z"),
};

test("payment reads preserve decimal, bigint, JSON, and timestamp semantics", async () => {
  const calls: QueryCall[] = [];
  const repository = createPaymentRepository(scriptedDatabase([
    { rows: [{
      id: orderId,
      restaurant_id: restaurantId,
      display_id: "9007199254740993",
      total_price: "51.80",
      status: "waiting_payment",
      payment_status: null,
      payment_confirmed_at: null,
    }] },
    { rows: [rawTransaction] },
  ], calls));

  const order = await repository.findOrderForManualPayment(orderId);
  const transaction = await repository.findTransactionById(transactionId);

  assert.equal(order?.displayId, "9007199254740993");
  assert.equal(order?.totalPrice, "51.80");
  assert.equal(transaction?.amount.amount, "51.80");
  assert.equal(transaction?.createdAt, "2026-09-25T12:00:00.000Z");
  assert.deepEqual(transaction?.providerPayload, { preferenceId: "pref-1" });
  assert.deepEqual(calls[0]?.values, [orderId]);
  assert.deepEqual(calls[1]?.values, [transactionId]);
});

test("provider account lookup applies restaurant, provider, status, and environment filters", async () => {
  const calls: QueryCall[] = [];
  const repository = createPaymentRepository(scriptedDatabase([{ rows: [{
    id: accountId,
    restaurant_id: restaurantId,
    provider: "mercado_pago",
    environment: "sandbox",
    status: "active",
    external_account_id: "seller-1",
    capabilities: { payments: true },
    version: 2,
  }] }], calls));

  const account = await repository.findActiveProviderAccount(
    restaurantId,
    "mercado_pago",
    "sandbox",
  );

  assert.equal(account?.restaurantId, restaurantId);
  assert.deepEqual(account?.capabilities, { payments: true });
  assert.deepEqual(calls[0]?.values, [restaurantId, "mercado_pago", "sandbox"]);
  assert.match(calls[0]?.sql ?? "", /status\s*=\s*'active'/i);
});

test("payment transaction creation is parameterized and maps duplicate conflicts", async () => {
  const calls: QueryCall[] = [];
  const repository = createPaymentRepository(scriptedDatabase([{ rows: [rawTransaction] }], calls));

  const transaction = await repository.createTransaction({
    restaurantId,
    orderId,
    providerAccountId: accountId,
    provider: "mercado_pago",
    idempotencyKey: "payment-attempt-0001",
    requestFingerprint: "fingerprint",
    amount: { amount: "51.80", currency: "BRL" },
    paymentMethod: "pix",
    processingMode: "online",
  });

  assert.equal(transaction.id, transactionId);
  assert.deepEqual(calls[0]?.values, [
    restaurantId,
    orderId,
    accountId,
    "mercado_pago",
    "payment-attempt-0001",
    "fingerprint",
    "51.80",
    "BRL",
    "pix",
    "online",
    null,
  ]);
  assert.match(calls[0]?.sql ?? "", /insert into public\.payment_transactions/i);

  const duplicate = new Error("duplicate key");
  Object.assign(duplicate, { code: "23505" });
  const conflicting = createPaymentRepository(scriptedDatabase([duplicate], []));
  await assert.rejects(
    () => conflicting.createTransaction({
      restaurantId,
      orderId,
      providerAccountId: accountId,
      provider: "mercado_pago",
      idempotencyKey: "payment-attempt-0001",
      requestFingerprint: "fingerprint",
      amount: { amount: "51.80", currency: "BRL" },
      paymentMethod: "pix",
      processingMode: "online",
    }),
    PaymentTransactionConflictError,
  );
});

test("payment transition delegates every versioned field to the Neon routine", async () => {
  const calls: QueryCall[] = [];
  const repository = createPaymentRepository(scriptedDatabase([
    { rows: [{ ...rawTransaction, status: "paid", version: 2 }] },
  ], calls));

  const transitioned = await repository.applyPaymentTransition({
    transactionId,
    expectedVersion: 1,
    newStatus: "paid",
    providerStatus: "approved",
    externalPaymentId: "payment-1",
    transitionedAt: "2026-09-25T12:10:00.000Z",
    checkoutUrl: null,
    expiresAt: null,
    providerPayload: { status: "approved" },
    effectTypes: ["release_order_to_kitchen"],
  });

  assert.equal(transitioned.status, "paid");
  assert.match(calls[0]?.sql ?? "", /public\.apply_payment_transition_v2/i);
  assert.deepEqual(calls[0]?.values, [
    transactionId,
    1,
    "paid",
    "approved",
    "payment-1",
    "2026-09-25T12:10:00.000Z",
    null,
    null,
    { status: "approved" },
    ["release_order_to_kitchen"],
  ]);
});

test("payment storage failures expose only the generic repository contract", async () => {
  const failure = new Error("postgresql://owner:secret@db select payment_transactions");
  const repository = createPaymentRepository(scriptedDatabase([failure], []));

  await assert.rejects(
    () => repository.findTransactionById(transactionId),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "payment_storage_error");
      assert.equal(error.message, "Failed to load payment transaction");
      assert.equal(error.diagnostics, undefined);
      assert.doesNotMatch(error.message, /secret|select|payment_transactions/i);
      return true;
    },
  );
});

test("payment effect operations call the versioned routines with complete lease data", async () => {
  const calls: QueryCall[] = [];
  const repository = createPaymentRepository(scriptedDatabase([
    { rows: [{
      id: "50000000-0000-4000-8000-000000000005",
      restaurant_id: restaurantId,
      payment_transaction_id: transactionId,
      effect_type: "release_order_to_kitchen",
      status: "processing",
      payload: {},
      attempts: 0,
      available_at: new Date("2026-09-25T12:00:00.000Z"),
      locked_until: new Date("2026-09-25T12:01:00.000Z"),
    }] },
    { rows: [{ complete_payment_effect: null }] },
    { rows: [{ fail_payment_effect: null }] },
    { rows: [{ release_paid_order_to_production: null }] },
    { rows: [{ count: "3" }] },
  ], calls));

  const effects = await repository.claimEffects({
    workerId: "worker-1",
    limit: 10,
    lockedAt: "2026-09-25T12:00:00.000Z",
    lockedUntil: "2026-09-25T12:01:00.000Z",
  });
  await repository.completeEffect({
    effectId: effects[0]!.id,
    workerId: "worker-1",
    processedAt: "2026-09-25T12:00:30.000Z",
  });
  await repository.failEffect({
    effectId: effects[0]!.id,
    workerId: "worker-1",
    status: "failed",
    attempts: 1,
    availableAt: "2026-09-25T12:02:00.000Z",
    lastError: "temporary",
  });
  await repository.releaseOrderToProduction({ paymentTransactionId: transactionId, restaurantId });
  const pending = await repository.countPendingEffects();

  assert.equal(effects[0]?.availableAt, "2026-09-25T12:00:00.000Z");
  assert.equal(pending, 3);
  assert.match(calls[0]?.sql ?? "", /public\.claim_payment_effects/i);
  assert.deepEqual(calls[3]?.values, [transactionId, restaurantId]);
  assert.match(calls[4]?.sql ?? "", /public\.count_pending_payment_effects/i);
});
