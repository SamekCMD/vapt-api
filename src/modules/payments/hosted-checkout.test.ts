import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { PaymentTransactionRecord } from "./repository.js";

const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const RESTAURANT_ID = "20000000-0000-4000-8000-000000000001";

const validConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: { app: "app", webhookSetup: "setup", admin: "admin" },
  },
  frontendUrl: new URL("https://vapt.example.com"),
  apiPublicUrl: new URL("https://api.vapt.example.com"),
  mercadoPago: {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: new URL("https://api.vapt.example.com/payments/mercado-pago/oauth/callback"),
    webhookSecret: "webhook-secret",
    tokenEncryptionKey: Buffer.alloc(32, 1),
    credentialKeyId: "env-v1",
    environment: "sandbox",
  },
  webhooks: { stripe: { signingSecret: "whsec_test", toleranceSeconds: 300 } },
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
} satisfies AppConfig;

function pendingTransaction(): PaymentTransactionRecord {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    restaurantId: RESTAURANT_ID,
    orderId: ORDER_ID,
    providerAccountId: "40000000-0000-4000-8000-000000000001",
    provider: "mercado_pago",
    externalPaymentId: null,
    idempotencyKey: "checkout-order-1",
    requestFingerprint: "fingerprint-1",
    amount: { amount: "42.50", currency: "BRL" },
    status: "pending",
    providerStatus: "preference_created",
    paymentMethod: null,
    processingMode: "online",
    providerPayload: { preferenceId: "preference-123" },
    manuallyConfirmedBy: null,
    checkoutUrl: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
    expiresAt: null,
    version: 2,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:01.000Z",
  };
}

function publicOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    displayId: 42,
    restaurantId: RESTAURANT_ID,
    tableSessionId: null,
    totalPrice: "42.50",
    status: "waiting_payment",
    paymentStatus: null,
    idempotentReplay: false,
    channel: "delivery" as const,
    tableNumber: null,
    createdAt: "2026-08-06T12:00:00.000Z",
    items: [],
    ...overrides,
  };
}

test("hosted checkout uses the persisted order total and server payment environment", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createHostedCheckoutService?: (input: Record<string, unknown>) => {
      start(input: Record<string, string>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof serviceModule.createHostedCheckoutService, "function");

  let loadedOrder: unknown = null;
  let paymentInput: Record<string, unknown> | null = null;
  const service = serviceModule.createHostedCheckoutService!({
    orderService: {
      async getPublicOrder(orderId: string, token: string) {
        loadedOrder = { orderId, token };
        return publicOrder();
      },
    },
    paymentService: {
      async startPayment(input: Record<string, unknown>) {
        paymentInput = input;
        return pendingTransaction();
      },
      async getTransaction() {
        return null;
      },
    },
    environment: "sandbox",
    returnUrls: {
      success: new URL("https://vapt.example.com/payment/return?result=success"),
      pending: new URL("https://vapt.example.com/payment/return?result=pending"),
      failure: new URL("https://vapt.example.com/payment/return?result=failure"),
    },
  });

  const result = await service.start({
    orderId: ORDER_ID,
    publicOrderToken: "public-order-token-12345678901234567890",
    idempotencyKey: "checkout-order-1",
  });

  assert.deepEqual(loadedOrder, {
    orderId: ORDER_ID,
    token: "public-order-token-12345678901234567890",
  });
  const captured = paymentInput as unknown as Record<string, unknown>;
  assert.deepEqual(captured.amount, { amount: "42.50", currency: "BRL" });
  assert.equal(captured.restaurantId, RESTAURANT_ID);
  assert.equal(captured.orderId, ORDER_ID);
  assert.equal(captured.provider, "mercado_pago");
  assert.equal(captured.environment, "sandbox");
  assert.equal(captured.processingMode, "online");
  assert.equal(captured.idempotencyKey, "checkout-order-1");
  assert.equal("publicOrderToken" in captured, false);
  assert.equal(result.checkoutUrl, pendingTransaction().checkoutUrl);
  assert.equal(result.status, "pending");
});

test("hosted checkout rejects an order already marked as paid", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createHostedCheckoutService?: (input: Record<string, unknown>) => {
      start(input: Record<string, string>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof serviceModule.createHostedCheckoutService, "function");
  let paymentCalls = 0;
  const service = serviceModule.createHostedCheckoutService!({
    orderService: {
      async getPublicOrder() {
        return publicOrder({ paymentStatus: "paid" });
      },
    },
    paymentService: {
      async startPayment() {
        paymentCalls += 1;
        return pendingTransaction();
      },
      async getTransaction() {
        return null;
      },
    },
    environment: "sandbox",
    returnUrls: {
      success: new URL("https://vapt.example.com/payment/return"),
      pending: new URL("https://vapt.example.com/payment/return"),
      failure: new URL("https://vapt.example.com/payment/return"),
    },
  });

  await assert.rejects(
    service.start({
      orderId: ORDER_ID,
      publicOrderToken: "public-order-token-12345678901234567890",
      idempotencyKey: "checkout-order-1",
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "order_already_paid",
  );
  assert.equal(paymentCalls, 0);
});

test("public hosted checkout route rejects browser-controlled amounts", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerHostedCheckoutRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
      service: { start(input: Record<string, string>): Promise<PaymentTransactionRecord> },
    ) => Promise<void>;
  };
  assert.equal(typeof routesModule.registerHostedCheckoutRoutes, "function");
  let calls = 0;
  const service = {
    async start() {
      calls += 1;
      return pendingTransaction();
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await routesModule.registerHostedCheckoutRoutes!(app, validConfig, service);

  const response = await app.inject({
    method: "POST",
    url: `/public/orders/${ORDER_ID}/payments/checkout`,
    headers: {
      "idempotency-key": "checkout-order-1",
      "x-vapt-order-token": "public-order-token-12345678901234567890",
    },
    payload: { amount: "0.01" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(calls, 0);
  await app.close();
});

test("public hosted checkout route requires the order token and returns only safe checkout data", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerHostedCheckoutRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
      service: { start(input: Record<string, string>): Promise<PaymentTransactionRecord> },
    ) => Promise<void>;
  };
  assert.equal(typeof routesModule.registerHostedCheckoutRoutes, "function");
  let received: unknown = null;
  const service = {
    async start(input: Record<string, string>) {
      received = input;
      return pendingTransaction();
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await routesModule.registerHostedCheckoutRoutes!(app, validConfig, service);

  const missingToken = await app.inject({
    method: "POST",
    url: `/public/orders/${ORDER_ID}/payments/checkout`,
    headers: { "idempotency-key": "checkout-order-1" },
    payload: {},
  });
  assert.equal(missingToken.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: `/public/orders/${ORDER_ID}/payments/checkout`,
    headers: {
      "idempotency-key": "checkout-order-1",
      "x-vapt-order-token": "public-order-token-12345678901234567890",
    },
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, {
    orderId: ORDER_ID,
    publicOrderToken: "public-order-token-12345678901234567890",
    idempotencyKey: "checkout-order-1",
  });
  assert.deepEqual(response.json(), {
    transactionId: pendingTransaction().id,
    orderId: ORDER_ID,
    status: "pending",
    amount: { amount: "42.50", currency: "BRL" },
    checkoutUrl: pendingTransaction().checkoutUrl,
    expiresAt: null,
  });
  assert.equal(response.body.includes("accessToken"), false);
  assert.equal(response.body.includes("providerPayload"), false);
  await app.close();
});
