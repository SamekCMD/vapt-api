import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import type { OwnershipLookup } from "../../lib/permissions.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import { PaymentTransactionConflictError, type PaymentTransactionRecord } from "./repository.js";
import { createManualPaymentRoutes } from "./routes.js";
import { manualPaymentBodySchema } from "./schemas.js";
import { createManualPaymentService, type ManualPaymentService } from "./service.js";
import { createManualPaymentProvider } from "./providers/manual.js";

const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const RESTAURANT_ID = "20000000-0000-4000-8000-000000000001";

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
      webhookSetup: "setup-secret",
      admin: "admin-secret",
    },
  },
  webhooks: {
    stripe: {
      signingSecret: "whsec_test",
      toleranceSeconds: 300,
    },
  },
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
};

function createToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", validConfig.supabase.jwtSecret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

const ownerToken = createToken({
  sub: "user-1",
  email: "owner@example.com",
  role: "authenticated",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function paidTransaction(overrides: Partial<PaymentTransactionRecord> = {}): PaymentTransactionRecord {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    restaurantId: RESTAURANT_ID,
    orderId: ORDER_ID,
    providerAccountId: null,
    provider: "manual",
    externalPaymentId: null,
    idempotencyKey: "manual-payment-1",
    requestFingerprint: "manual-fingerprint",
    amount: { amount: "42.50", currency: "BRL" },
    status: "paid",
    providerStatus: "confirmed_by_operator",
    paymentMethod: "cash",
    processingMode: "manual",
    providerPayload: {},
    checkoutUrl: null,
    expiresAt: null,
    manuallyConfirmedBy: "user-1",
    version: 2,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:01.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    restaurantId: RESTAURANT_ID,
    displayId: 42,
    totalPrice: "42.50",
    status: "ready",
    paymentStatus: null,
    paymentConfirmedAt: null,
    ...overrides,
  };
}

test("manual provider confirms an operator-recorded payment without external capabilities", async () => {
  const provider = createManualPaymentProvider(() => "2026-08-01T12:00:01.000Z");

  assert.deepEqual(provider.getCapabilities(), {
    onlineCheckout: false,
    webhooks: false,
    cancellation: false,
    fullRefunds: false,
    partialRefunds: false,
    oauthConnection: false,
  });

  const payment = await provider.createPayment({
    transactionId: "transaction-1",
    restaurantId: RESTAURANT_ID,
    orderId: ORDER_ID,
    providerAccountId: null,
    environment: "sandbox",
    amount: { amount: "42.50", currency: "BRL" },
    paymentMethod: "cash",
    description: "Pedido 42",
    idempotencyKey: "manual-payment-1",
    returnUrls: null,
  });

  assert.equal(payment.status, "paid");
  assert.equal(payment.provider, "manual");
  assert.equal(payment.externalPaymentId, null);
  assert.equal(payment.providerStatus, "confirmed_by_operator");
});

test("manual confirmation uses the order amount and records the authenticated operator", async () => {
  let startInput: Record<string, unknown> | null = null;
  const ownershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
    userId === "user-1" && restaurantId === RESTAURANT_ID;
  const service = createManualPaymentService({
    repository: {
      findOrderForManualPayment: async () => order(),
    },
    paymentService: {
      startPayment: async (input) => {
        startInput = input as unknown as Record<string, unknown>;
        return paidTransaction({
          paymentMethod: input.paymentMethod,
          manuallyConfirmedBy: input.confirmedByUserId ?? null,
        });
      },
      getTransaction: async () => null,
    },
    ownershipLookup,
  });

  const result = await service.confirm({
    orderId: ORDER_ID,
    paymentMethod: "cash",
    idempotencyKey: "manual-payment-1",
    userId: "user-1",
    authRole: "authenticated",
  });

  const capturedStartInput = startInput as unknown as {
    amount: unknown;
    restaurantId: string;
    confirmedByUserId: string;
  };
  assert.equal(result.status, "paid");
  assert.deepEqual(capturedStartInput.amount, {
    amount: "42.50",
    currency: "BRL",
  });
  assert.equal(capturedStartInput.restaurantId, RESTAURANT_ID);
  assert.equal(capturedStartInput.confirmedByUserId, "user-1");
  assert.equal("amount" in result, true);
});

test("manual confirmation rejects a token without the authenticated operator role", async () => {
  let loaded = false;
  const service = createManualPaymentService({
    repository: {
      findOrderForManualPayment: async () => {
        loaded = true;
        return order();
      },
    },
    paymentService: {
      startPayment: async () => paidTransaction(),
      getTransaction: async () => null,
    },
    ownershipLookup: async () => true,
  });

  await assert.rejects(
    service.confirm({
      orderId: ORDER_ID,
      paymentMethod: "cash",
      idempotencyKey: "manual-payment-1",
      userId: "user-1",
      authRole: "anon",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(loaded, false);
});

test("manual confirmation rejects an order owned by another tenant", async () => {
  let started = false;
  const service = createManualPaymentService({
    repository: { findOrderForManualPayment: async () => order() },
    paymentService: {
      startPayment: async () => {
        started = true;
        return paidTransaction();
      },
      getTransaction: async () => null,
    },
    ownershipLookup: async () => false,
  });

  await assert.rejects(
    service.confirm({
      orderId: ORDER_ID,
      paymentMethod: "cash",
      idempotencyKey: "manual-payment-1",
      userId: "user-2",
      authRole: "authenticated",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(started, false);
});

test("manual confirmation rejects an order that is already paid", async () => {
  const service = createManualPaymentService({
    repository: {
      findOrderForManualPayment: async () => order({
        paymentStatus: "paid",
        paymentConfirmedAt: "2026-08-01T12:00:00.000Z",
      }),
    },
    paymentService: {
      startPayment: async () => paidTransaction(),
      getTransaction: async () => null,
    },
    ownershipLookup: async () => true,
  });

  await assert.rejects(
    service.confirm({
      orderId: ORDER_ID,
      paymentMethod: "cash",
      idempotencyKey: "manual-payment-1",
      userId: "user-1",
      authRole: "authenticated",
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "order_already_paid",
  );
});

test("manual confirmation maps a concurrent transaction to conflict", async () => {
  const service = createManualPaymentService({
    repository: { findOrderForManualPayment: async () => order() },
    paymentService: {
      startPayment: async () => {
        throw new PaymentTransactionConflictError();
      },
      getTransaction: async () => null,
    },
    ownershipLookup: async () => true,
  });

  await assert.rejects(
    service.confirm({
      orderId: ORDER_ID,
      paymentMethod: "cash",
      idempotencyKey: "manual-payment-concurrent",
      userId: "user-1",
      authRole: "authenticated",
    }),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 409 && error.code === "payment_conflict",
  );
});

test("manual payment body rejects browser-controlled amounts", () => {
  const parsed = manualPaymentBodySchema.safeParse({
    paymentMethod: "cash",
    amount: "0.01",
  });
  assert.equal(parsed.success, false);
});

test("manual payment route requires authentication and a bounded idempotency key", async () => {
  let calls = 0;
  const fakeService: ManualPaymentService = {
    confirm: async () => {
      calls += 1;
      return paidTransaction();
    },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await createManualPaymentRoutes(app, validConfig, fakeService);

  const unauthenticated = await app.inject({
    method: "POST",
    url: `/orders/${ORDER_ID}/payments/manual-confirmation`,
    headers: { "idempotency-key": "manual-payment-1" },
    payload: { paymentMethod: "cash" },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const injectedAmount = await app.inject({
    method: "POST",
    url: `/orders/${ORDER_ID}/payments/manual-confirmation`,
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "idempotency-key": "manual-payment-1",
    },
    payload: { paymentMethod: "cash", amount: "0.01" },
  });
  assert.equal(injectedAmount.statusCode, 400);
  assert.equal(calls, 0);

  await app.close();
});

test("manual payment route passes only authenticated identity and allowed fields", async () => {
  let received: Parameters<ManualPaymentService["confirm"]>[0] | null = null;
  const fakeService: ManualPaymentService = {
    confirm: async (input) => {
      received = input;
      return paidTransaction();
    },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await createManualPaymentRoutes(app, validConfig, fakeService);

  const response = await app.inject({
    method: "POST",
    url: `/orders/${ORDER_ID}/payments/manual-confirmation`,
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "idempotency-key": "manual-payment-1",
    },
    payload: { paymentMethod: "external_pix" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, {
    orderId: ORDER_ID,
    paymentMethod: "external_pix",
    idempotencyKey: "manual-payment-1",
    userId: "user-1",
    authRole: "authenticated",
  });
  const payload = response.json() as Record<string, unknown>;
  assert.equal(payload.status, "paid");
  assert.deepEqual(payload.amount, { amount: "42.50", currency: "BRL" });

  await app.close();
});
