import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";
import { createWorkerServices } from "./services.js";
import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { AppError } from "../lib/errors.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import type { OrderService } from "../modules/orders/service.js";
import type { MenuRepository } from "../modules/menu/repository.js";
import { createMenuService } from "../modules/menu/service.js";
import type { CatalogService, FeedbackService, MercadoPagoServices, StripeBillingService, StripeWebhookService, TableSessionService } from "../composition/api-services.js";
import { createPaymentModule } from "../modules/payments/composition.js";
import type { PaymentTransactionRecord } from "../modules/payments/repository.js";
import { parseWorkerJson, requireWorkerAuth, trustedRateLimitKey, workerRateLimit } from "./http.js";

type FixtureBindings = WorkerBindings & { TEST_GREETING: string };

const fakeDatabase = {
  async query() { return { rows: [] }; },
  async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
} as unknown as Database;
const fakeAuthRuntime: AuthRuntime = {
  async handler(request) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "session=one; Secure; HttpOnly; SameSite=Lax; Path=/");
    headers.append("set-cookie", "session=two; Secure; HttpOnly; SameSite=Lax; Path=/");
    return new Response(JSON.stringify({
      method: request.method,
      search: new URL(request.url).search,
      body: request.method === "POST" ? await request.text() : null,
    }), { headers });
  },
  async getSession(headers) {
    if (!headers.get("cookie")?.includes("session=owner")) return null;
    return {
      user: { id: "user-1", email: "owner@vapt.test", name: "Owner" },
      session: { id: "session-1", userId: "user-1", expiresAt: new Date("2030-01-01") },
    };
  },
  async close() {},
};
const fixtureOrderId = "10000000-0000-4000-8000-000000000011";
const fixtureSessionId = "10000000-0000-4000-8000-000000000012";
const fixtureOrderToken = "synthetic-public-order-token-1234567890";
const orderFingerprints = new Map<string, string>();
const fakeOrders: OrderService = {
  async createPublicOrder(body, key) {
    const fingerprint = JSON.stringify(body);
    const previous = orderFingerprints.get(key);
    if (previous && previous !== fingerprint) {
      throw new AppError(409, "idempotency_conflict", "Idempotency key was reused with another order");
    }
    orderFingerprints.set(key, fingerprint);
    return {
      orderId: fixtureOrderId, displayId: "11", restaurantId: "synthetic-restaurant-id",
      tableSessionId: fixtureSessionId, totalPrice: "12.00", status: "pending",
      paymentStatus: null, publicToken: fixtureOrderToken, idempotentReplay: !!previous,
    };
  },
  async getPublicOrder(orderId, token) {
    if (orderId !== fixtureOrderId || token !== fixtureOrderToken) {
      throw new AppError(404, "not_found", "Order not found");
    }
    return {
      orderId, displayId: "11", restaurantId: "synthetic-restaurant-id",
      tableSessionId: fixtureSessionId, totalPrice: "12.00", status: "waiting_payment",
      paymentStatus: null, idempotentReplay: false, channel: "local", tableNumber: "1",
      createdAt: "2026-09-29T00:00:00.000Z", items: [],
    };
  },
};
const fakeCatalog = {
  async getPublishedCatalog() {
    return { restaurant: {
      id: "synthetic-restaurant-id", name: "Synthetic Restaurant", slug: "synthetic-restaurant",
      whatsapp: null, address: null, phone: null, hours: null, description: null,
      primaryColor: "#000000", secondaryColor: "#ffffff", fontFamily: "sans-serif",
      logoUrl: null, totalTables: 1, maxTables: 1, paymentMode: "open_tab" as const,
      maxPendingOrders: 1, localEnabled: true, deliveryEnabled: false,
      updatedAt: "2026-09-29T00:00:00.000Z",
    }, items: [] };
  },
} satisfies CatalogService;
const fakeFeedback = {
  async submitOrderFeedback(orderId: string, token: string, body: { rating: number; reasons: string[]; comment: string | null }) {
    await fakeOrders.getPublicOrder(orderId, token);
    return { orderId, restaurantId: "synthetic-restaurant-id", ...body, createdAt: "2026-09-29T00:00:00.000Z" };
  },
} as FeedbackService;
const fakeTableSessions = {
  async requestPublicCheck(sessionId: string, order: { tableSessionId: string | null }) {
    if (sessionId !== order.tableSessionId) throw new AppError(404, "table_session_not_found", "Table session not found");
    return { sessionId, status: "check_requested" as const };
  },
} as TableSessionService;
const fakeMenu = createMenuService({
  async listOwnedMenuItems() { return []; },
  async createOwnedMenuItem() { return null; },
  async updateOwnedMenuItem() { return null; },
  async deleteOwnedMenuItem(userId: string, itemId: string) {
    return userId === "user-1" && itemId === "10000000-0000-4000-8000-000000000021";
  },
} satisfies MenuRepository, { publicBaseUrl: null });
const fakeStripeBilling = {
  async createCheckout(input: { userId: string; restaurantId: string; email: string; idempotencyKey: string }) {
    if (input.userId !== "user-1" || input.restaurantId !== "10000000-0000-4000-8000-000000000001") {
      throw new AppError(403, "forbidden", "Forbidden");
    }
    if (!input.idempotencyKey) throw new AppError(400, "invalid_request", "A valid Idempotency-Key is required");
    return { checkoutSessionId: "cs_synthetic", url: "https://checkout.stripe.com/synthetic" };
  },
  async createPortal(input: { userId: string; restaurantId: string }) {
    if (input.userId !== "user-1" || input.restaurantId !== "10000000-0000-4000-8000-000000000001") {
      throw new AppError(403, "forbidden", "Forbidden");
    }
    return { url: "https://billing.stripe.com/synthetic" };
  },
  async getSubscriptionStatus(input: { userId: string; restaurantId: string }) {
    if (input.userId !== "user-1" || input.restaurantId !== "10000000-0000-4000-8000-000000000001") {
      throw new AppError(403, "forbidden", "Forbidden");
    }
    return { planType: "pro", planStatus: "active" };
  },
} as unknown as StripeBillingService;
let stripeWebhookCalls = 0;
let stripeSideEffects = 0;
const processedStripeEvents = new Set<string>();
const fakeStripeWebhooks = {
  async handleEvent(event: unknown) {
    stripeWebhookCalls++;
    const id = (event as { id: string }).id;
    const duplicate = processedStripeEvents.has(id);
    if (!duplicate) {
      processedStripeEvents.add(id);
      stripeSideEffects++;
    }
    return { received: true, duplicate, ignored: true, providerEventId: id };
  },
} satisfies StripeWebhookService;
const fakePaymentModule = createPaymentModule({ nodeEnv: "test" } as AppConfig, fakeDatabase, [], {
  workerId: "synthetic-payments", onError() {},
});
const fakeTransaction: PaymentTransactionRecord = {
  id: "10000000-0000-4000-8000-000000000031",
  restaurantId: "synthetic-restaurant-id", orderId: fixtureOrderId,
  providerAccountId: "synthetic-account-id", provider: "mercado_pago", externalPaymentId: null,
  idempotencyKey: "synthetic-checkout", requestFingerprint: "synthetic-fingerprint",
  amount: { amount: "12.00", currency: "BRL" }, status: "pending", providerStatus: null,
  paymentMethod: null, processingMode: "online", providerPayload: { checkoutDiagnostics: null },
  manuallyConfirmedBy: null, checkoutUrl: "https://www.mercadopago.com.br/checkout/synthetic",
  expiresAt: "2030-01-01T00:00:00.000Z", version: 1,
  createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
};
fakePaymentModule.service = {
  async startPayment() { return fakeTransaction; },
  async getTransaction() { return fakeTransaction; },
};
let mercadoPagoWebhookCalls = 0;
let mercadoPagoSideEffects = 0;
let mercadoPagoRawBody = "";
const processedMercadoPagoEvents = new Set<string>();
const fakeMercadoPago = {
  oauth: {
    async beginConnection() { return { authorizationUrl: "https://auth.mercadopago.com/authorization?synthetic=1" }; },
    async handleCallback() { return { status: "connected", returnOrigin: "https://app.vapt.test" }; },
    async getStatus() { return { status: "active" }; },
    async disconnect() { return { status: "disconnected" }; },
  },
  returnReconciliation: { async reconcile() { return { ...fakeTransaction, status: "paid" }; } },
  diagnostics: { async inspect() { return { found: false }; } },
  webhook: {
    async handle(input: { rawBody: string }) {
      mercadoPagoWebhookCalls++;
      mercadoPagoRawBody = input.rawBody;
      const id = String((JSON.parse(input.rawBody) as { id: string }).id);
      const duplicate = processedMercadoPagoEvents.has(id);
      if (!duplicate) {
        processedMercadoPagoEvents.add(id);
        mercadoPagoSideEffects++;
      }
      return duplicate ? { received: true, duplicate: true } : { received: true, duplicate: false, ignored: true };
    },
  },
} as unknown as MercadoPagoServices;
let serviceFactoryCalls = 0;
const app = createWorkerApp((env, context) => {
  serviceFactoryCalls++;
  const mercadoPagoEnabled = Boolean(env.MERCADO_PAGO_CLIENT_ID);
  return createWorkerServices(env, context, {
    config: {
      nodeEnv: "test",
      corsOrigins: ["https://app.vapt.test"],
      frontendUrl: new URL("https://app.vapt.test"),
      apiPublicUrl: new URL("https://api.vapt.test"),
      security: { publicOrderTokenSecret: "synthetic-public-order-secret" },
      stripe: {
        secretKey: "sk_test_synthetic", webhookSecret: "whsec_synthetic",
        webhookToleranceSeconds: 300, environment: "test", portalConfigurationId: "bpc_synthetic",
        prices: { starter: "price_starter", pro: "price_pro", business: "price_business" },
      },
      paymentEffects: { pollIntervalMs: 5_000, batchSize: 25, leaseMs: 60_000, maxAttempts: 5, retryBaseMs: 30_000 },
      mercadoPago: mercadoPagoEnabled ? {
        clientId: "synthetic", clientSecret: "synthetic", redirectUri: new URL("https://api.vapt.test/payments/mercado-pago/oauth/callback"),
        webhookSecret: "synthetic-webhook-secret", tokenEncryptionKey: Buffer.alloc(32), credentialKeyId: "synthetic",
        environment: "sandbox", testAccessToken: "synthetic-test-token",
      } : undefined,
    } as AppConfig,
    database: fakeDatabase,
    authRuntime: fakeAuthRuntime,
    stripeGateway: {} as StripeGateway,
    catalog: fakeCatalog,
    orders: fakeOrders,
    feedback: fakeFeedback,
    tableSessions: fakeTableSessions,
    menu: fakeMenu,
    stripeWebhooks: fakeStripeWebhooks,
    stripeBilling: fakeStripeBilling,
    ...(mercadoPagoEnabled ? { mercadoPago: fakeMercadoPago, payments: fakePaymentModule } : {}),
    ownershipLookup: async ({ userId, restaurantId }) =>
      userId === "user-1" && restaurantId === "10000000-0000-4000-8000-000000000001",
  });
}, { authRateLimit: false, publicRateLimit: false, privateRateLimit: false, stripeRateLimit: false, paymentRateLimit: false });
app.get("/_test/composition-counts", (context) => context.json({ serviceFactoryCalls }));
app.get("/_test/stripe-counts", (context) => context.json({ stripeWebhookCalls, stripeSideEffects }));
app.get("/_test/mercado-pago-counts", (context) => context.json({
  mercadoPagoWebhookCalls, mercadoPagoSideEffects, mercadoPagoRawBody,
}));
app.get("/_test/missing-ingress", (context) => {
  trustedRateLimitKey(new Headers({ "x-forwarded-for": "1.2.3.4" }), "auth");
  return context.json({ unexpected: true });
});
app.get("/_test/protected", workerRateLimit("auth"), async (context) => {
  const auth = await requireWorkerAuth(context);
  return context.json({ userId: auth.userId });
});
app.post("/_test/parse", async (context) => context.json(await parseWorkerJson(context.req.raw)));
app.get("/_test/echo/:value", (context) => context.json({
  value: context.req.param("value"),
  query: context.req.query("q"),
  greeting: (context.env as FixtureBindings).TEST_GREETING,
}));

export default { fetch: app.fetch };
