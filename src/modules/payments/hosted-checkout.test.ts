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
  corsOrigins: ["http://localhost:5173", "https://vapt-preview.vercel.app"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: { app: "app", admin: "admin" },
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
    providerPayload: {
      preferenceId: "preference-123",
      checkoutDiagnostics: {
        collectorId: "seller-123",
        clientId: "client-id",
        marketplace: "MP-MKT-client-id",
        siteId: "MLB",
        operationType: "regular_payment",
        checkoutHost: "www.mercadopago.com.br",
        sandboxCheckoutHost: "sandbox.mercadopago.com.br",
      },
    },
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

test("hosted checkout rejects orders that are not waiting for payment", async () => {
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
        return publicOrder({ status: "pending" });
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
      error.code === "order_not_waiting_payment",
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
    diagnostics: {
      collectorId: "seller-123",
      clientId: "client-id",
      marketplace: "MP-MKT-client-id",
      siteId: "MLB",
      operationType: "regular_payment",
      checkoutHost: "www.mercadopago.com.br",
      sandboxCheckoutHost: "sandbox.mercadopago.com.br",
    },
  });
  assert.equal(response.body.includes("accessToken"), false);
  assert.equal(response.body.includes("providerPayload"), false);
  await app.close();
});

test("sandbox payment diagnostics require the order token and return only safe attempt details", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerMercadoPagoDiagnosticsRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
      service: { inspect(input: Record<string, string>): Promise<Record<string, unknown>> },
    ) => Promise<void>;
  };
  assert.equal(typeof routesModule.registerMercadoPagoDiagnosticsRoutes, "function");
  let received: unknown = null;
  const service = {
    async inspect(input: Record<string, string>) {
      received = input;
      return {
        transactionId: pendingTransaction().id,
        transactionStatus: "pending",
        found: true,
        attempt: {
          paymentId: "987654321",
          status: "rejected",
          statusDetail: "cc_rejected_other_reason",
          paymentMethodId: "visa",
          amount: "42.50",
          currency: "BRL",
          collectorId: "seller-123",
          dateLastUpdated: "2026-08-08T12:10:00.000Z",
        },
      };
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await routesModule.registerMercadoPagoDiagnosticsRoutes!(app, validConfig, service);

  const missingToken = await app.inject({
    method: "GET",
    url: `/public/orders/${ORDER_ID}/payments/${pendingTransaction().id}/diagnostics`,
  });
  assert.equal(missingToken.statusCode, 400);

  const response = await app.inject({
    method: "GET",
    url: `/public/orders/${ORDER_ID}/payments/${pendingTransaction().id}/diagnostics`,
    headers: { "x-vapt-order-token": "public-order-token-12345678901234567890" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, {
    orderId: ORDER_ID,
    transactionId: pendingTransaction().id,
    publicOrderToken: "public-order-token-12345678901234567890",
  });
  assert.deepEqual(response.json(), await service.inspect({}));
  assert.equal(response.body.includes("accessToken"), false);
  assert.equal(response.body.includes("providerPayload"), false);
  await app.close();
});

test("payment diagnostics route is unavailable outside the sandbox", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerMercadoPagoDiagnosticsRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
      service: { inspect(input: Record<string, string>): Promise<Record<string, unknown>> },
    ) => Promise<void>;
  };
  assert.equal(typeof routesModule.registerMercadoPagoDiagnosticsRoutes, "function");
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await routesModule.registerMercadoPagoDiagnosticsRoutes!(app, {
    ...validConfig,
    mercadoPago: { ...validConfig.mercadoPago, environment: "production" },
  }, { async inspect() { return {}; } });

  const response = await app.inject({
    method: "GET",
    url: `/public/orders/${ORDER_ID}/payments/${pendingTransaction().id}/diagnostics`,
    headers: { "x-vapt-order-token": "public-order-token-12345678901234567890" },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("payment diagnostics load the latest Mercado Pago attempt without exposing credentials", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoPaymentDiagnosticsService?: (input: Record<string, unknown>) => {
      inspect(input: Record<string, string>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof serviceModule.createMercadoPagoPaymentDiagnosticsService, "function");
  let tokenResolution: unknown = null;
  let searchInput: unknown = null;
  const service = serviceModule.createMercadoPagoPaymentDiagnosticsService!({
    orderService: {
      async getPublicOrder(orderId: string, token: string) {
        assert.deepEqual({ orderId, token }, {
          orderId: ORDER_ID,
          token: "public-order-token-12345678901234567890",
        });
        return publicOrder();
      },
    },
    paymentService: {
      async getTransaction() { return pendingTransaction(); },
    },
    resolveAccessToken: async (input: unknown) => {
      tokenResolution = input;
      return "TEST-private-token";
    },
    resolveProviderAccountDiagnostics: async () => ({
      externalAccountId: "seller-123",
      environment: "sandbox",
      scope: "read write offline_access",
      liveMode: false,
    }),
    paymentClient: {
      async searchPayments(input: unknown) {
        searchInput = input;
        return [{
          id: "987654321",
          status: "rejected",
          statusDetail: "cc_rejected_other_reason",
          transactionAmount: "42.50",
          currency: "BRL",
          externalReference: pendingTransaction().id,
          collectorId: "seller-123",
          dateLastUpdated: "2026-08-08T12:10:00.000Z",
          paymentMethodId: "visa",
        }];
      },
    },
    checkoutClient: {
      async getPreference(input: unknown) {
        assert.deepEqual(input, {
          accessToken: "TEST-private-token",
          preferenceId: "preference-123",
        });
        return {
          preferenceId: "preference-123",
          collectorId: "seller-123",
          marketplaceFee: "0.01",
          externalReference: pendingTransaction().id,
        };
      },
    },
  });

  const result = await service.inspect({
    orderId: ORDER_ID,
    transactionId: pendingTransaction().id,
    publicOrderToken: "public-order-token-12345678901234567890",
  });

  assert.deepEqual(tokenResolution, {
    providerAccountId: pendingTransaction().providerAccountId,
    restaurantId: RESTAURANT_ID,
  });
  assert.deepEqual(searchInput, {
    accessToken: "TEST-private-token",
    externalReference: pendingTransaction().id,
  });
  assert.deepEqual(result, {
    transactionId: pendingTransaction().id,
    transactionStatus: "pending",
    found: true,
    providerAccount: {
      externalAccountId: "seller-123",
      environment: "sandbox",
      scope: "read write offline_access",
      liveMode: false,
    },
    createdPreference: {
      preferenceId: "preference-123",
      collectorId: "seller-123",
      clientId: "client-id",
      marketplace: "MP-MKT-client-id",
      siteId: "MLB",
      operationType: "regular_payment",
      checkoutHost: "www.mercadopago.com.br",
      sandboxCheckoutHost: "sandbox.mercadopago.com.br",
    },
    preference: {
      preferenceId: "preference-123",
      collectorId: "seller-123",
      marketplaceFee: "0.01",
      externalReference: pendingTransaction().id,
    },
    attempt: {
      paymentId: "987654321",
      status: "rejected",
      statusDetail: "cc_rejected_other_reason",
      paymentMethodId: "visa",
      amount: "42.50",
      currency: "BRL",
      collectorId: "seller-123",
      dateLastUpdated: "2026-08-08T12:10:00.000Z",
    },
  });
  assert.equal(JSON.stringify(result).includes("TEST-private-token"), false);
});

test("payment diagnostics reject a transaction from another order before provider access", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoPaymentDiagnosticsService?: (input: Record<string, unknown>) => {
      inspect(input: Record<string, string>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof serviceModule.createMercadoPagoPaymentDiagnosticsService, "function");
  let providerCalls = 0;
  const service = serviceModule.createMercadoPagoPaymentDiagnosticsService!({
    orderService: { async getPublicOrder() { return publicOrder(); } },
    paymentService: {
      async getTransaction() {
        return { ...pendingTransaction(), orderId: "50000000-0000-4000-8000-000000000001" };
      },
    },
    resolveAccessToken: async () => {
      providerCalls += 1;
      return "TEST-private-token";
    },
    paymentClient: {
      async searchPayments() {
        providerCalls += 1;
        return [];
      },
    },
    checkoutClient: {
      async getPreference() {
        providerCalls += 1;
        return {};
      },
    },
  });

  await assert.rejects(
    service.inspect({
      orderId: ORDER_ID,
      transactionId: pendingTransaction().id,
      publicOrderToken: "public-order-token-12345678901234567890",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
  assert.equal(providerCalls, 0);
});

test("payment diagnostics preserve the payment attempt when preference lookup fails", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoPaymentDiagnosticsService?: (input: Record<string, unknown>) => {
      inspect(input: Record<string, string>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof serviceModule.createMercadoPagoPaymentDiagnosticsService, "function");
  const service = serviceModule.createMercadoPagoPaymentDiagnosticsService!({
    orderService: { async getPublicOrder() { return publicOrder(); } },
    paymentService: { async getTransaction() { return pendingTransaction(); } },
    resolveAccessToken: async () => "TEST-private-token",
    paymentClient: {
      async searchPayments() {
        return [{
          id: "987654321",
          status: "rejected",
          statusDetail: "cc_rejected_other_reason",
          transactionAmount: "42.50",
          currency: "BRL",
          externalReference: pendingTransaction().id,
          collectorId: "seller-123",
          dateLastUpdated: "2026-08-08T12:10:00.000Z",
          paymentMethodId: "visa",
        }];
      },
    },
    checkoutClient: {
      async getPreference() {
        throw new AppError(424, "mercado_pago_checkout_failed", "Mercado Pago preference request failed (status 403: access_denied)");
      },
    },
  });

  const result = await service.inspect({
    orderId: ORDER_ID,
    transactionId: pendingTransaction().id,
    publicOrderToken: "public-order-token-12345678901234567890",
  });

  assert.deepEqual(result, {
    transactionId: pendingTransaction().id,
    transactionStatus: "pending",
    found: true,
    createdPreference: {
      preferenceId: "preference-123",
      collectorId: "seller-123",
      clientId: "client-id",
      marketplace: "MP-MKT-client-id",
      siteId: "MLB",
      operationType: "regular_payment",
      checkoutHost: "www.mercadopago.com.br",
      sandboxCheckoutHost: "sandbox.mercadopago.com.br",
    },
    preference: null,
    preferenceLookup: "unavailable",
    preferenceLookupError: {
      code: "mercado_pago_checkout_failed",
      statusCode: 424,
      providerStatusCode: 403,
      providerReason: "access_denied",
    },
    attempt: {
      paymentId: "987654321",
      status: "rejected",
      statusDetail: "cc_rejected_other_reason",
      paymentMethodId: "visa",
      amount: "42.50",
      currency: "BRL",
      collectorId: "seller-123",
      dateLastUpdated: "2026-08-08T12:10:00.000Z",
    },
  });
  assert.equal(JSON.stringify(result).includes("TEST-private-token"), false);
  assert.equal(JSON.stringify(result).includes("APP_USR-application-token"), false);
});

test("Mercado Pago return URLs use the API relay and preserve an allowed frontend origin", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    createMercadoPagoReturnUrls?: (config: AppConfig, requestedOrigin?: string) => {
      success: URL;
      pending: URL;
      failure: URL;
    };
  };

  assert.equal(typeof routesModule.createMercadoPagoReturnUrls, "function");
  const urls = routesModule.createMercadoPagoReturnUrls!(
    validConfig,
    "https://vapt-preview.vercel.app",
  );

  assert.equal(
    urls.success.toString(),
    "https://api.vapt.example.com/payments/mercado-pago/return?result=success&return_origin=https%3A%2F%2Fvapt-preview.vercel.app",
  );
  assert.equal(
    urls.pending.toString(),
    "https://api.vapt.example.com/payments/mercado-pago/return?result=pending&return_origin=https%3A%2F%2Fvapt-preview.vercel.app",
  );
  assert.equal(
    urls.failure.toString(),
    "https://api.vapt.example.com/payments/mercado-pago/return?result=failure&return_origin=https%3A%2F%2Fvapt-preview.vercel.app",
  );
});

test("Mercado Pago return relay redirects to the allowed checkout origin and preserves only safe parameters", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerMercadoPagoReturnRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
    ) => Promise<void>;
  };

  assert.equal(typeof routesModule.registerMercadoPagoReturnRoutes, "function");
  const app = Fastify({ logger: false });
  await routesModule.registerMercadoPagoReturnRoutes!(app, validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/payments/mercado-pago/return?result=success&return_origin=https%3A%2F%2Fvapt-preview.vercel.app&payment_id=123&status=approved&external_reference=transaction-456&preference_id=preference-789&unsafe_secret=hidden",
  });

  assert.equal(response.statusCode, 302);
  const location = new URL(response.headers.location!);
  assert.equal(location.origin, "https://vapt-preview.vercel.app");
  assert.equal(location.pathname, "/payment/return");
  assert.equal(location.searchParams.get("result"), "success");
  assert.equal(location.searchParams.get("payment_id"), "123");
  assert.equal(location.searchParams.get("status"), "approved");
  assert.equal(location.searchParams.get("external_reference"), "transaction-456");
  assert.equal(location.searchParams.get("preference_id"), "preference-789");
  assert.equal(location.searchParams.has("unsafe_secret"), false);

  await app.close();
});

test("Mercado Pago return relay never redirects to an untrusted origin", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerMercadoPagoReturnRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
    ) => Promise<void>;
  };

  const app = Fastify({ logger: false });
  await routesModule.registerMercadoPagoReturnRoutes!(app, validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/payments/mercado-pago/return?result=pending&return_origin=https%3A%2F%2Fevil.example.com",
  });

  assert.equal(response.statusCode, 302);
  assert.equal(new URL(response.headers.location!).origin, "https://vapt.example.com");
  await app.close();
});

test("Mercado Pago return relay reconciles the official payment before redirecting", async () => {
  const routesModule = await import("./routes.js") as unknown as {
    registerMercadoPagoReturnRoutes?: (
      app: ReturnType<typeof Fastify>,
      config: AppConfig,
      service: {
        reconcile(input: { transactionId: string; paymentId: string }): Promise<{ status: string }>;
      },
    ) => Promise<void>;
  };

  assert.equal(typeof routesModule.registerMercadoPagoReturnRoutes, "function");
  const reconciliations: Array<{ transactionId: string; paymentId: string }> = [];
  const app = Fastify({ logger: false });
  await routesModule.registerMercadoPagoReturnRoutes!(app, validConfig, {
    async reconcile(input) {
      reconciliations.push(input);
      return { status: "paid" };
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/payments/mercado-pago/return?result=success&payment_id=123&status=approved&external_reference=transaction-456",
  });

  assert.equal(response.statusCode, 302);
  assert.deepEqual(reconciliations, [{ transactionId: "transaction-456", paymentId: "123" }]);
  const location = new URL(response.headers.location!);
  assert.equal(location.searchParams.get("result"), "success");

  await app.close();
});

test("Mercado Pago return reconciliation applies an approved payment once with the kitchen effect", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoReturnReconciliationService?: (input: Record<string, unknown>) => {
      reconcile(input: { transactionId: string; paymentId: string }): Promise<PaymentTransactionRecord>;
    };
  };

  assert.equal(typeof serviceModule.createMercadoPagoReturnReconciliationService, "function");
  const transitions: Array<Record<string, unknown>> = [];
  const transaction = pendingTransaction();
  const service = serviceModule.createMercadoPagoReturnReconciliationService!({
    repository: {
      async findTransactionById() {
        return transaction;
      },
      async applyPaymentTransition(input: Record<string, unknown>) {
        transitions.push(input);
        return { ...transaction, status: input.newStatus, version: transaction.version + 1 };
      },
    },
    resolveAccessToken: async () => "TEST-access-token",
    resolveProviderAccountDiagnostics: async () => ({
      externalAccountId: "seller-123",
      environment: "production",
    }),
    client: {
      async getPayment() {
        return {
          id: "payment-123",
          status: "approved",
          statusDetail: "accredited",
          transactionAmount: "42.50",
          currency: "BRL",
          externalReference: transaction.id,
          collectorId: "seller-123",
          dateLastUpdated: "2026-08-19T18:42:04.000Z",
          paymentMethodId: "pix",
        };
      },
    },
  });

  const result = await service.reconcile({
    transactionId: transaction.id,
    paymentId: "payment-123",
  });

  assert.equal(result.status, "paid");
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0]?.effectTypes, ["release_order_to_kitchen"]);
  assert.equal(transitions[0]?.externalPaymentId, "payment-123");
});

test("sandbox return validates the collector recorded when the preference was created", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoReturnReconciliationService?: (input: Record<string, unknown>) => {
      reconcile(input: { transactionId: string; paymentId: string }): Promise<PaymentTransactionRecord>;
    };
  };

  const transitions: Array<Record<string, unknown>> = [];
  const transaction = pendingTransaction();
  const service = serviceModule.createMercadoPagoReturnReconciliationService!({
    repository: {
      async findTransactionById() {
        return transaction;
      },
      async applyPaymentTransition(input: Record<string, unknown>) {
        transitions.push(input);
        return { ...transaction, status: input.newStatus, version: transaction.version + 1 };
      },
    },
    resolveAccessToken: async () => "TEST-application-access-token",
    resolveProviderAccountDiagnostics: async () => ({
      externalAccountId: "oauth-seller-3595396809",
      environment: "sandbox",
    }),
    client: {
      async getPayment() {
        return {
          id: "payment-123",
          status: "approved",
          statusDetail: "accredited",
          transactionAmount: "42.50",
          currency: "BRL",
          externalReference: transaction.id,
          collectorId: "seller-123",
          dateLastUpdated: "2026-08-19T18:42:04.000Z",
          paymentMethodId: "account_money",
        };
      },
    },
  });

  const result = await service.reconcile({
    transactionId: transaction.id,
    paymentId: "payment-123",
  });

  assert.equal(result.status, "paid");
  assert.equal(transitions.length, 1);
});

test("Mercado Pago return reconciliation is idempotent after the webhook already paid", async () => {
  const serviceModule = await import("./service.js") as unknown as {
    createMercadoPagoReturnReconciliationService?: (input: Record<string, unknown>) => {
      reconcile(input: { transactionId: string; paymentId: string }): Promise<PaymentTransactionRecord>;
    };
  };

  assert.equal(typeof serviceModule.createMercadoPagoReturnReconciliationService, "function");
  let providerCalls = 0;
  let transitionCalls = 0;
  const transaction = {
    ...pendingTransaction(),
    status: "paid" as const,
    externalPaymentId: "payment-123",
  };
  const service = serviceModule.createMercadoPagoReturnReconciliationService!({
    repository: {
      async findTransactionById() {
        return transaction;
      },
      async applyPaymentTransition() {
        transitionCalls += 1;
        return transaction;
      },
    },
    resolveAccessToken: async () => "TEST-access-token",
    resolveProviderAccountDiagnostics: async () => ({
      externalAccountId: "seller-123",
      environment: "production",
    }),
    client: {
      async getPayment() {
        providerCalls += 1;
        throw new Error("must not fetch an already reconciled payment");
      },
    },
  });

  const result = await service.reconcile({
    transactionId: transaction.id,
    paymentId: "payment-123",
  });

  assert.equal(result.status, "paid");
  assert.equal(providerCalls, 0);
  assert.equal(transitionCalls, 0);
});
