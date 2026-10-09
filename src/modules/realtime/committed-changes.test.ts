import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import type { AppConfig } from "../../lib/config.js";
import { createApiServices } from "../../composition/api-services.js";
import type { Database, Queryable } from "../../lib/database.js";
import type { CommittedChange } from "./contracts.js";
import { createOrderRepository } from "../orders/repository.js";
import { createOrderService } from "../orders/service.js";
import { createKitchenRepository } from "../kitchen/repository.js";
import { createTableSessionRepository } from "../table-sessions/repository.js";
import { createPaymentRepository, type ApplyPaymentTransitionInput } from "../payments/repository.js";
import { createPaymentModule } from "../payments/composition.js";
import { createManualPaymentProvider } from "../payments/providers/manual.js";
import { createHostedCheckoutService, createMercadoPagoReturnReconciliationService } from "../payments/service.js";
import { createMercadoPagoWebhookService } from "../payments/providers/mercado-pago/webhook.js";
import type { PaymentProvider } from "../payments/provider.js";

const rest = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const paymentId = "55555555-5555-4555-8555-555555555555";
const accountId = "66666666-6666-4666-8666-666666666666";
const effectId = "77777777-7777-4777-8777-777777777777";
const timestamp = "2026-10-05T12:00:00.000Z";
const transition: ApplyPaymentTransitionInput = { transactionId: paymentId, expectedVersion: 1,
  newStatus: "paid", providerStatus: "approved", externalPaymentId: null, transitionedAt: timestamp,
  checkoutUrl: null, expiresAt: null, providerPayload: {}, effectTypes: null };

// Fake only the SQL boundary; repositories, services, transaction lifecycle and
// publisher sequencing below are real. A failed commit restores synthetic state.
function fixture(options: { failCommit?: boolean; publisherFails?: boolean; noSession?: boolean } = {}) {
  const trace: string[] = [];
  const published: CommittedChange[] = [];
  let state = { orderStatus: "pending", sessionStatus: "open", table: "1", orderTable: "1", paymentStatus: "created",
    version: 1, created: false, orderPayment: null as string | null, transactionCreated: false,
    provider: "manual", providerAccountId: null as string | null, externalPaymentId: null as string | null,
    checkoutUrl: null as string | null, key: "synthetic-key", fingerprint: "synthetic-hash",
    paymentMethod: "cash" as string | null, processingMode: "manual", effect: false, webhook: "" };
  let snapshot = { ...state };
  const rawOrder = () => ({ id: orderId, display_id: "1", restaurant_id: rest, table_session_id: options.noSession ? null : sessionId,
    table_number: state.orderTable, total_price: "10.00", status: state.orderStatus, payment_status: state.orderPayment,
    payment_confirmed_at: null,
    order_channel: "local", created_at: timestamp, updated_at: timestamp, items: [] });
  const rawPayment = () => ({ id: paymentId, restaurant_id: rest, order_id: orderId, provider_account_id: state.providerAccountId,
    provider: state.provider, external_payment_id: state.externalPaymentId, idempotency_key: state.key, request_fingerprint: state.fingerprint,
    amount: "10.00", currency: "BRL", status: state.paymentStatus, provider_status: null, payment_method: state.paymentMethod,
    processing_mode: state.processingMode, manually_confirmed_by: userId, provider_payload: {}, checkout_url: state.checkoutUrl,
    expires_at: null, version: state.version, created_at: timestamp, updated_at: timestamp });
  async function query(sql: string, values: any[] = []): Promise<{ rows: any[] }> {
    trace.push(sql.trim());
    if (sql === "BEGIN") { snapshot = { ...state }; return { rows: [] }; }
    if (sql === "COMMIT") { if (options.failCommit) throw new Error("synthetic commit failure"); return { rows: [] }; }
    if (sql === "ROLLBACK") { state = { ...snapshot }; return { rows: [] }; }
    if (/^set transaction/i.test(sql)) return { rows: [] };
    if (/create_public_order_v3/.test(sql)) {
      const replay = state.created; state.created = true;
      return { rows: [{ order_id: orderId, display_id: "1", restaurant_id: rest, table_session_id: options.noSession ? null : sessionId,
        total_price: "10.00", status: state.orderStatus, payment_status: state.orderPayment, idempotent_replay: replay }] };
    }
    if (/apply_payment_transition_v2/.test(sql)) {
      if (state.paymentStatus !== values[2]) { state.paymentStatus = values[2]; state.version++; }
      state.orderPayment = state.paymentStatus;
      state.externalPaymentId = values[4]; state.checkoutUrl = values[6];
      if (values[9]?.includes("release_order_to_kitchen")) state.effect = true;
      return { rows: [rawPayment()] };
    }
    if (/release_paid_order_to_production/.test(sql)) {
      if (state.orderStatus === "waiting_payment") state.orderStatus = "paid";
      return { rows: [{ release_paid_order_to_production: null }] };
    }
    if (/from public\.payment_transactions/i.test(sql)) {
      assert.doesNotMatch(sql, /for (?:update|share|key share|no key update)/i, "payment row UPDATE privilege must not be required");
      if (/and idempotency_key/.test(sql) && (!state.transactionCreated || values[1] !== state.key)) return { rows: [] };
      return { rows: [rawPayment()] };
    }
    if (/insert into public\.payment_transactions/i.test(sql)) {
      assert.equal(values[0], rest); assert.equal(values[1], orderId); assert.equal(values[6], "10.00");
      state.transactionCreated = true; state.providerAccountId = values[2]; state.provider = values[3];
      state.key = values[4]; state.fingerprint = values[5]; state.paymentMethod = values[8]; state.processingMode = values[9];
      return { rows: [rawPayment()] };
    }
    if (/from public\.payment_provider_accounts/i.test(sql)) return { rows: [{ id: accountId, restaurant_id: rest,
      provider: "mercado_pago", environment: "sandbox", status: "active", external_account_id: "3595396809", capabilities: {}, version: 1 }] };
    if (/insert into public\.payment_webhook_events/i.test(sql)) {
      if (state.webhook) return { rows: [] }; state.webhook = "received"; return { rows: [{ id: effectId }] };
    }
    if (/update public\.payment_webhook_events/i.test(sql)) { state.webhook = values[2]; return { rows: [] }; }
    if (/from public\.payment_webhook_events/i.test(sql)) return { rows: [{ status: state.webhook, attempts: 1 }] };
    if (/claim_payment_effects/.test(sql)) return { rows: state.effect ? [{ id: effectId, restaurant_id: rest,
      payment_transaction_id: paymentId, effect_type: "release_order_to_kitchen", status: "processing", payload: {},
      attempts: 0, available_at: timestamp, locked_until: timestamp }] : [] };
    if (/complete_payment_effect/.test(sql)) { state.effect = false; return { rows: [] }; }
    if (/fail_payment_effect/.test(sql)) return { rows: [] };
    if (/count_pending_payment_effects/.test(sql)) return { rows: [{ count: state.effect ? 1 : 0 }] };
    if (/select session_row\.status/i.test(sql)) return { rows: [{ status: state.sessionStatus,
      closed_at: state.sessionStatus === "closed" ? timestamp : null, table_number: state.table, restaurant_id: rest }] };
    if (/update public\.table_sessions/i.test(sql)) {
      if (/check_requested/.test(sql)) state.sessionStatus = "check_requested";
      else if (/closed_at/.test(sql)) state.sessionStatus = "closed";
      else state.table = values[0];
      return { rows: [{ id: sessionId, restaurant_id: rest, closed_at: timestamp }] };
    }
    if (/update public\.orders/i.test(sql)) {
      if (/set status/i.test(sql)) state.orderStatus = values[0];
      if (/set table_number/i.test(sql)) {
        const changed = state.orderTable !== values[0];
        if (/is distinct from/i.test(sql) && !changed) return { rows: [] };
        state.orderTable = values[0];
      }
      return { rows: [{ id: orderId, restaurant_id: rest }] };
    }
    if (/from public\.order_items/i.test(sql)) return { rows: [] };
    if (/from public\.orders/i.test(sql)) return { rows: [rawOrder()] };
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  }
  const client = { query, release() { trace.push("RELEASE"); } };
  const database = { query, async connect() { return client; } } as unknown as Database;
  const observer = { async publishCommittedChange(change: CommittedChange) {
    trace.push("publish"); published.push(change);
    if (options.publisherFails) throw new Error("synthetic transport failure");
  } };
  return { database, observer, trace, published, state: () => state, rawPayment };
}
function assertCommitted(trace: string[]) {
  assert.ok(trace.indexOf("COMMIT") >= 0);
  assert.ok(trace.indexOf("COMMIT") < trace.indexOf("publish"));
  assert.ok(trace.indexOf("RELEASE") < trace.indexOf("publish"));
}
const orderBody = { restaurantSlug: "synthetic", channel: "local", tableNumber: 1,
  items: [{ menuItemId: paymentId, quantity: 1 }] } as const;

test("new order publishes authoritative minimal topics after commit; replay and failed commit publish nothing", async () => {
  const f = fixture();
  const repository = createOrderRepository(f.database, f.observer);
  const service = createOrderService(repository, "synthetic-public-secret");
  const first = await service.createPublicOrder({ ...orderBody, items: [...orderBody.items] }, "same-key");
  assert.equal(first.idempotentReplay, false);
  assert.deepEqual(f.published, [{ restaurantId: rest, topics: ["orders", "kitchen", "table_sessions"], orderIds: [orderId], entityId: orderId, reason: "created" }]);
  assertCommitted(f.trace);
  assert.equal((await service.createPublicOrder({ ...orderBody, items: [...orderBody.items] }, "same-key")).idempotentReplay, true);
  assert.equal(f.published.length, 1);
  assert.deepEqual(Object.keys(first).sort(), ["displayId", "idempotentReplay", "orderId", "paymentStatus", "publicToken", "restaurantId", "status", "tableSessionId", "totalPrice"]);
  const failed = fixture({ failCommit: true });
  await assert.rejects(createOrderService(createOrderRepository(failed.database, failed.observer), "synthetic").createPublicOrder({ ...orderBody, items: [...orderBody.items] }, "key"));
  assert.equal(failed.published.length, 0);
  assert.ok(failed.trace.includes("ROLLBACK"));
});

test("kitchen emits only actual status changes, after commit, and transport failure preserves DTO", async () => {
  const f = fixture({ publisherFails: true });
  const repository = createKitchenRepository(f.database, f.observer);
  const dto = await repository.updateOwnedOrderStatus(userId, orderId, "ready", () => {});
  assert.ok(dto); assert.equal(dto.status, "ready");
  assert.deepEqual(f.published[0], { restaurantId: rest, topics: ["orders", "kitchen", "table_sessions"], orderIds: [orderId], entityId: orderId, reason: "updated" });
  assertCommitted(f.trace);
  await repository.updateOwnedOrderStatus(userId, orderId, "ready", () => {});
  assert.equal(f.published.length, 1);
  const baseline = fixture();
  assert.deepEqual(dto, await createKitchenRepository(baseline.database).updateOwnedOrderStatus(userId, orderId, "ready", () => {}));
  const failed = fixture({ failCommit: true });
  await assert.rejects(createKitchenRepository(failed.database, failed.observer).updateOwnedOrderStatus(userId, orderId, "ready", () => {}));
  assert.equal(failed.published.length, 0);
});

test("public check invalidates only table scope and close captures affected orders without replay emissions", async () => {
  const f = fixture();
  const repository = createTableSessionRepository(f.database, f.observer);
  assert.deepEqual(await repository.requestPublicCheck(sessionId, orderId), { sessionId, status: "check_requested" });
  assert.deepEqual(f.published[0], { restaurantId: rest, topics: ["table_sessions"], orderIds: [], entityId: sessionId, reason: "check_requested" });
  assertCommitted(f.trace);
  await repository.requestPublicCheck(sessionId, orderId);
  assert.equal(f.published.length, 1);
  const closed = await repository.closeOwnedSession(userId, sessionId);
  assert.deepEqual(closed, { sessionId, status: "closed", closedAt: timestamp, deliveredOrderIds: [orderId] });
  assert.deepEqual(f.published[1], { restaurantId: rest, topics: ["table_sessions", "orders", "kitchen"], orderIds: [orderId], entityId: sessionId, reason: "closed" });
  await repository.closeOwnedSession(userId, sessionId);
  assert.equal(f.published.length, 2);
  const failed = fixture({ failCommit: true });
  await assert.rejects(createTableSessionRepository(failed.database, failed.observer).requestPublicCheck(sessionId, orderId));
  assert.equal(failed.published.length, 0);
});

test("transfer emits only changed authoritative order IDs and same table is a no-op", async () => {
  const f = fixture();
  const repository = createTableSessionRepository(f.database, f.observer);
  await repository.transferOwnedSession(userId, sessionId, "2");
  assert.equal(f.published.length, 1);
  assert.deepEqual(f.published[0], { restaurantId: rest, topics: ["table_sessions", "orders", "kitchen"],
    orderIds: [orderId], entityId: sessionId, reason: "transferred" });
  assertCommitted(f.trace);
  await repository.transferOwnedSession(userId, sessionId, "2");
  assert.equal(f.published.length, 1);
});

test("orders without a session omit table invalidation and table mutations cannot publish a failed commit", async () => {
  const f = fixture({ noSession: true, publisherFails: true });
  const result = await createOrderService(createOrderRepository(f.database, f.observer), "synthetic-public-secret")
    .createPublicOrder({ ...orderBody, items: [...orderBody.items] }, "key");
  assert.equal(result.tableSessionId, null);
  assert.deepEqual(f.published[0].topics, ["orders", "kitchen"]);
  for (const operation of ["close", "transfer"] as const) {
    const failed = fixture({ failCommit: true });
    const repository = createTableSessionRepository(failed.database, failed.observer);
    await assert.rejects(operation === "close" ? repository.closeOwnedSession(userId, sessionId)
      : repository.transferOwnedSession(userId, sessionId, "2"));
    assert.equal(failed.published.length, 0); assert.ok(failed.trace.includes("ROLLBACK"));
    assert.equal(failed.state().sessionStatus, "open"); assert.equal(failed.state().orderTable, "1");
  }
});

test("payment transition version/status is compared in a committed controlled transaction, not stale expectedVersion", async () => {
  const f = fixture({ publisherFails: true });
  const repository = createPaymentRepository(f.database, f.observer);
  const first = await repository.applyPaymentTransition(transition);
  assert.equal(first.status, "paid");
  assert.deepEqual(f.published[0], { restaurantId: rest, topics: ["payments", "orders", "kitchen", "table_sessions"], orderIds: [orderId], entityId: paymentId, reason: "payment_changed" });
  assertCommitted(f.trace);
  assert.ok(f.trace.some(sql => /set transaction isolation level serializable/i.test(sql)));
  await repository.applyPaymentTransition(transition);
  assert.equal(f.published.length, 1, "stale expectedVersion does not turn same-status replay into a change");
  const failed = fixture({ failCommit: true });
  await assert.rejects(createPaymentRepository(failed.database, failed.observer).applyPaymentTransition(transition));
  assert.equal(failed.published.length, 0);
});

test("void payment release locks and compares order state; repeated release and failed commit do not emit", async () => {
  const f = fixture();
  f.state().orderStatus = "waiting_payment";
  f.state().paymentStatus = "paid";
  const repository = createPaymentRepository(f.database, f.observer);
  await repository.releaseOrderToProduction({ paymentTransactionId: paymentId, restaurantId: rest });
  assert.deepEqual(f.published[0], { restaurantId: rest, topics: ["orders", "kitchen", "table_sessions"], orderIds: [orderId], entityId: orderId, reason: "updated" });
  assertCommitted(f.trace);
  assert.ok(f.trace.some(sql => /for update of order_row/i.test(sql)));
  await repository.releaseOrderToProduction({ paymentTransactionId: paymentId, restaurantId: rest });
  assert.equal(f.published.length, 1);
  const failed = fixture({ failCommit: true });
  failed.state().orderStatus = "waiting_payment";
  await assert.rejects(createPaymentRepository(failed.database, failed.observer).releaseOrderToProduction({ paymentTransactionId: paymentId, restaurantId: rest }));
  assert.equal(failed.published.length, 0);
});

test("unmanaged queryables and leased clients cannot claim post-commit observation", () => {
  const f = fixture();
  const queryable = { query: f.database.query } as Queryable;
  const leased = { ...f.database, release() {} } as unknown as Queryable;
  for (const database of [queryable, leased]) {
    assert.throws(() => createOrderRepository(database, f.observer), /managed.*pool/i);
    assert.throws(() => createPaymentRepository(database, f.observer), /managed.*pool/i);
  }
  assert.doesNotThrow(() => createOrderRepository(queryable));
  assert.doesNotThrow(() => createPaymentRepository(queryable));
});

const config = { nodeEnv: "test", security: { publicOrderTokenSecret: "synthetic-public-secret" } } as AppConfig;
function api(f: ReturnType<typeof fixture>, providers: readonly PaymentProvider[] = [createManualPaymentProvider(() => timestamp)]) {
  return createApiServices(config, { database: f.database, ...f.observer, paymentProviders: providers,
    ownershipLookup: async ({ userId: candidate, restaurantId }) => candidate === userId && restaurantId === rest,
    workerId: "synthetic-worker", startPaymentReconciliation: false });
}

test("shared API composition connects order, kitchen and table writes to post-commit publishers", async () => {
  const f = fixture(); const services = api(f);
  await services.orders.createPublicOrder({ ...orderBody, items: [...orderBody.items] }, "key");
  assert.equal(f.published.length, 1);
  await services.kitchen.updateOwnedOrderStatus(userId, orderId, "preparing");
  assert.equal(f.published.length, 2);
  await services.tableSessions.requestPublicCheck(sessionId, { orderId, tableSessionId: sessionId });
  assert.equal(f.published.length, 3);
  assertCommitted(f.trace);
});

test("manual confirmation through shared composition and effect reconciliation publish committed changes only once", async () => {
  const f = fixture({ publisherFails: true }); f.state().orderStatus = "waiting_payment";
  const services = api(f);
  const result = await services.manualPayments.confirm({ userId, authRole: "authenticated", orderId,
    paymentMethod: "cash", idempotencyKey: "manual-key" });
  assert.equal(result.status, "paid"); assert.equal(result.amount.amount, "10.00");
  assert.deepEqual(f.published.map(change => change.reason), ["payment_changed"]);
  assertCommitted(f.trace);
  assert.deepEqual(await services.payments.reconciliation.runOnce(), { claimed: 1, completed: 1, failed: 0, deadLettered: 0, pending: 0 });
  assert.deepEqual(f.published.map(change => change.reason), ["payment_changed", "updated"]);
  assert.equal(f.state().orderStatus, "paid");
  await services.payments.reconciliation.runOnce();
  await assert.rejects(services.manualPayments.confirm({ userId, authRole: "authenticated", orderId,
    paymentMethod: "cash", idempotencyKey: "manual-key" }), /already paid/i);
  assert.equal(f.published.length, 2);
  const failed = fixture({ failCommit: true });
  await assert.rejects(api(failed).manualPayments.confirm({ userId, authRole: "authenticated", orderId,
    paymentMethod: "cash", idempotencyKey: "manual-key" }));
  assert.equal(failed.published.length, 0);
});

const onlineProvider: PaymentProvider = {
  code: "mercado_pago",
  getCapabilities: () => ({ onlineCheckout: true, webhooks: true, cancellation: true, fullRefunds: true, partialRefunds: false, oauthConnection: true }),
  async createPayment(input) {
    assert.equal(input.restaurantId, rest); assert.equal(input.orderId, orderId);
    return { transactionId: input.transactionId, provider: "mercado_pago", status: "pending", amount: input.amount,
      paymentMethod: null, externalPaymentId: null, providerStatus: "preference_created", occurredAt: timestamp,
      metadata: {}, checkoutUrl: new URL("https://checkout.synthetic.test/"), expiresAt: null };
  },
  async getPaymentStatus() { throw new Error("unused synthetic provider operation"); },
};
const providerPayment = { id: "123456789", status: "approved", statusDetail: "accredited", transactionAmount: "10.00",
  currency: "BRL", externalReference: paymentId, collectorId: "3595396809", dateLastUpdated: timestamp, paymentMethodId: "pix" };

test("hosted checkout and return reconciliation use the real observed repository; replays do not republish", async () => {
  const f = fixture(); f.state().orderStatus = "waiting_payment";
  const services = api(f, [onlineProvider]);
  const checkout = createHostedCheckoutService({ orderService: services.orders, paymentService: services.payments.service,
    environment: "sandbox", returnUrls: { success: new URL("https://synthetic.test/success"), pending: new URL("https://synthetic.test/pending"), failure: new URL("https://synthetic.test/failure") } });
  const input = { orderId, publicOrderToken: "synthetic-token", idempotencyKey: "checkout-key" };
  assert.equal((await checkout.start(input)).checkoutUrl, "https://checkout.synthetic.test/");
  assert.equal(f.published.length, 1); assertCommitted(f.trace);
  await checkout.start(input); assert.equal(f.published.length, 1);
  const returns = createMercadoPagoReturnReconciliationService({ repository: services.payments.repository,
    resolveAccessToken: async () => "synthetic-token", resolveProviderAccountDiagnostics: async () => ({ externalAccountId: "3595396809", environment: "sandbox" }),
    client: { async getPayment() { return providerPayment; } } });
  assert.equal((await returns.reconcile({ transactionId: paymentId, paymentId: "123456789" })).status, "paid");
  assert.equal(f.published.length, 2);
  await returns.reconcile({ transactionId: paymentId, paymentId: "123456789" });
  assert.equal(f.published.length, 2);
});

test("signed Mercado Pago webhook through a composed repository emits once, and a failed commit emits nothing", async () => {
  for (const failCommit of [false, true]) {
    const f = fixture({ failCommit }); Object.assign(f.state(), { provider: "mercado_pago", providerAccountId: accountId, paymentStatus: "pending", version: 2 });
    const module = createPaymentModule(config, f.database, [onlineProvider], { workerId: "synthetic", onError() {}, ...f.observer });
    const webhook = createMercadoPagoWebhookService({ webhookSecret: "synthetic-webhook-secret", repository: module.repository,
      resolveAccessToken: async () => "synthetic-token", client: { async getPayment() { return providerPayment; } } });
    const manifest = "id:123456789;request-id:synthetic-request;ts:1786069000;";
    const input = { rawBody: JSON.stringify({ id: 987654321, live_mode: false, type: "payment", action: "payment.updated", user_id: 3595396809, data: { id: "123456789" } }),
      dataId: "123456789", requestId: "synthetic-request", signatureHeader: `ts=1786069000,v1=${createHmac("sha256", "synthetic-webhook-secret").update(manifest).digest("hex")}` };
    if (failCommit) { await assert.rejects(webhook.handle(input)); assert.equal(f.published.length, 0); }
    else {
      assert.deepEqual(await webhook.handle(input), { received: true, duplicate: false, status: "paid" });
      assert.equal(f.published.length, 1); assertCommitted(f.trace);
      assert.deepEqual(await webhook.handle(input), { received: true, duplicate: true });
      assert.equal(f.published.length, 1);
    }
  }
});
