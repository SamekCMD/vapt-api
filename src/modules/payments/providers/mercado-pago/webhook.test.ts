import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type {
  ApplyPaymentTransitionInput,
  PaymentProviderAccountRecord,
  PaymentRepository,
  PaymentTransactionRecord,
  ReservePaymentWebhookEventInput,
} from "../../repository.js";
import {
  createMercadoPagoWebhookService,
  verifyMercadoPagoWebhookSignature,
} from "./webhook.js";

const SECRET = "mercado-pago-webhook-secret";
const DATA_ID = "123456789";
const REQUEST_ID = "request-123";
const TIMESTAMP = "1786069000";

function signature(dataId = DATA_ID, requestId = REQUEST_ID) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${TIMESTAMP};`;
  const digest = createHmac("sha256", SECRET).update(manifest).digest("hex");
  return `ts=${TIMESTAMP},v1=${digest}`;
}

const account: PaymentProviderAccountRecord = {
  id: "20000000-0000-4000-8000-000000000001",
  restaurantId: "30000000-0000-4000-8000-000000000001",
  provider: "mercado_pago",
  environment: "sandbox",
  status: "active",
  externalAccountId: "3595396809",
  capabilities: {},
  version: 1,
};

const transaction: PaymentTransactionRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  restaurantId: account.restaurantId,
  orderId: "40000000-0000-4000-8000-000000000001",
  providerAccountId: account.id,
  provider: "mercado_pago",
  externalPaymentId: null,
  idempotencyKey: "checkout-1",
  requestFingerprint: "fingerprint-1",
  amount: { amount: "23.00", currency: "BRL" },
  status: "pending",
  providerStatus: "preference_created",
  paymentMethod: null,
  processingMode: "online",
  providerPayload: {},
  manuallyConfirmedBy: null,
  checkoutUrl: "https://www.mercadopago.com.br/checkout/v1/redirect",
  expiresAt: null,
  version: 2,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

class WebhookRepositoryStub implements Pick<
  PaymentRepository,
  | "findActiveProviderAccountByExternalAccountId"
  | "findTransactionById"
  | "reserveWebhookEvent"
  | "markWebhookEvent"
  | "applyPaymentTransition"
> {
  duplicate = false;
  reservations: ReservePaymentWebhookEventInput[] = [];
  marks: Array<{ status: string; error: string | null }> = [];
  transitions: ApplyPaymentTransitionInput[] = [];

  async findActiveProviderAccountByExternalAccountId() {
    return account;
  }

  async findTransactionById() {
    return transaction;
  }

  async reserveWebhookEvent(input: ReservePaymentWebhookEventInput) {
    this.reservations.push(input);
    return { duplicate: this.duplicate };
  }

  async markWebhookEvent(_provider: "mercado_pago", _eventId: string, status: "processed" | "ignored" | "failed", lastError: string | null) {
    this.marks.push({ status, error: lastError });
  }

  async applyPaymentTransition(input: ApplyPaymentTransitionInput) {
    this.transitions.push(input);
    return { ...transaction, status: input.newStatus, version: transaction.version + 1 };
  }
}

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 987654321,
    live_mode: false,
    type: "payment",
    action: "payment.updated",
    user_id: 3595396809,
    data: { id: DATA_ID },
    ...overrides,
  });
}

test("Mercado Pago signature follows the documented manifest and rejects tampering", () => {
  assert.equal(verifyMercadoPagoWebhookSignature({
    dataId: DATA_ID,
    requestId: REQUEST_ID,
    signatureHeader: signature(),
    secret: SECRET,
  }), true);

  assert.equal(verifyMercadoPagoWebhookSignature({
    dataId: "tampered",
    requestId: REQUEST_ID,
    signatureHeader: signature(),
    secret: SECRET,
  }), false);
  assert.equal(verifyMercadoPagoWebhookSignature({
    dataId: DATA_ID,
    requestId: REQUEST_ID,
    signatureHeader: "invalid",
    secret: SECRET,
  }), false);
});

test("approved payment is fetched from Mercado Pago and applied once with an outbox effect", async () => {
  const repository = new WebhookRepositoryStub();
  const service = createMercadoPagoWebhookService({
    webhookSecret: SECRET,
    repository,
    resolveAccessToken: async () => "TEST-access-token",
    client: {
      async getPayment() {
        return {
          id: DATA_ID,
          status: "approved",
          statusDetail: "accredited",
          transactionAmount: "23.00",
          currency: "BRL",
          externalReference: transaction.id,
          collectorId: account.externalAccountId!,
          dateLastUpdated: "2026-08-08T12:05:00.000Z",
          paymentMethodId: "pix",
        };
      },
    },
  });

  const result = await service.handle({
    rawBody: webhookPayload(),
    dataId: DATA_ID,
    requestId: REQUEST_ID,
    signatureHeader: signature(),
  });

  assert.deepEqual(result, { received: true, duplicate: false, status: "paid" });
  assert.equal(repository.reservations.length, 1);
  assert.equal(repository.transitions.length, 1);
  assert.deepEqual(repository.transitions[0]?.effectTypes, ["release_order_to_kitchen"]);
  assert.equal(repository.transitions[0]?.externalPaymentId, DATA_ID);
  assert.deepEqual(repository.marks, [{ status: "processed", error: null }]);
});

test("duplicate notifications acknowledge receipt without fetching or transitioning again", async () => {
  const repository = new WebhookRepositoryStub();
  repository.duplicate = true;
  let providerCalls = 0;
  const service = createMercadoPagoWebhookService({
    webhookSecret: SECRET,
    repository,
    resolveAccessToken: async () => "TEST-access-token",
    client: {
      async getPayment() {
        providerCalls += 1;
        throw new Error("should not run");
      },
    },
  });

  const result = await service.handle({
    rawBody: webhookPayload(),
    dataId: DATA_ID,
    requestId: REQUEST_ID,
    signatureHeader: signature(),
  });

  assert.deepEqual(result, { received: true, duplicate: true });
  assert.equal(providerCalls, 0);
  assert.equal(repository.transitions.length, 0);
});

test("provider amount mismatch fails the event without changing the transaction", async () => {
  const repository = new WebhookRepositoryStub();
  const service = createMercadoPagoWebhookService({
    webhookSecret: SECRET,
    repository,
    resolveAccessToken: async () => "TEST-access-token",
    client: {
      async getPayment() {
        return {
          id: DATA_ID,
          status: "approved",
          statusDetail: "accredited",
          transactionAmount: "999.00",
          currency: "BRL",
          externalReference: transaction.id,
          collectorId: account.externalAccountId!,
          dateLastUpdated: "2026-08-08T12:05:00.000Z",
          paymentMethodId: "pix",
        };
      },
    },
  });

  await assert.rejects(service.handle({
    rawBody: webhookPayload(),
    dataId: DATA_ID,
    requestId: REQUEST_ID,
    signatureHeader: signature(),
  }), /amount/i);
  assert.equal(repository.transitions.length, 0);
  assert.deepEqual(repository.marks, [{ status: "failed", error: "provider_response_mismatch" }]);
});
