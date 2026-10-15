import assert from "node:assert/strict";
import test from "node:test";
import type { StripeBillingConfig } from "../../../lib/config.js";
import type { Queryable } from "../../../lib/database.js";
import { AppError } from "../../../lib/errors.js";
import { createStripeWebhookService } from "./webhook-service.js";
import type { StripeGateway, StripeSubscription } from "./types.js";
import type { ReconciliationScope, StripeWebhookRepository, BillingEmailIntent } from "./webhook-repository.js";

const config: StripeBillingConfig = { secretKey: "sk_test_vapt", webhookSecret: "whsec_vapt", environment: "test",
  webhookToleranceSeconds: 300, portalConfigurationId: "bpc_vapt",
  prices: { starter: "price_starter", pro: "price_pro", business: "price_business" } };
const metadata = { vapt_restaurant_id: "10000000-0000-4000-8000-000000000001",
  vapt_owner_id: "20000000-0000-4000-8000-000000000001", vapt_plan_type: "pro" };
function event(type: string, extra: Record<string, unknown> = {}) {
  const object = type.startsWith("checkout.") ? { object: "checkout.session", id: "cs_test_vapt", mode: "subscription",
    customer: "cus_vapt", subscription: type.endsWith("expired") ? null : "sub_vapt", client_reference_id: metadata.vapt_restaurant_id, metadata } :
    type.startsWith("invoice.") ? { object: "invoice", id: "in_vapt", customer: "cus_vapt",
      parent: { subscription_details: { subscription: "sub_vapt", metadata } }, billing_reason: "subscription_create" } :
      { object: "subscription", id: "sub_vapt", customer: "cus_vapt", metadata };
  return { id: "evt_vapt", type, created: 1790500000, livemode: false, data: { object: { ...object, ...extra } } };
}
function fixture() {
  const scope: ReconciliationScope = { restaurantId: metadata.vapt_restaurant_id, userId: metadata.vapt_owner_id,
    stripeCustomerId: "cus_vapt", stripeSubscriptionId: null, checkoutSessionId: "cs_test_vapt",
    planStatus: "trialing", stateUpdatedAt: null };
  const subscription: StripeSubscription = { id: "sub_vapt", customerId: "cus_vapt", livemode: false, metadata: { ...metadata },
    status: "active", items: [{ id: "si_vapt", priceId: "price_pro", recurring: true, currentPeriodEnd: "2030-01-01T00:00:00.000Z" }],
    trialEndsAt: null, cancelAtPeriodEnd: false, canceledAt: null };
  const writes: unknown[] = []; const intents: BillingEmailIntent[] = []; const claims: unknown[] = [];
  const transaction = { query: async () => ({ rows: [] }) } as unknown as Queryable;
  let terminal = false; let attempts = 0; let lookup: ReconciliationScope | null = scope;
  const logs: unknown[] = []; let retrievals = 0;
  const repository: StripeWebhookRepository = {
    async claimEvent(input) { claims.push(input); return terminal ? { kind: "duplicate_processed" } : { kind: "claimed", attemptCount: ++attempts }; },
    async markFailed(input) { writes.push({ failed: input }); },
    async withClaimedEvent(_input, work) { const outcome = await work(transaction); writes.push({ outcome }); terminal = true; },
    async resolveRestaurant(tx, input) { assert.equal(tx, transaction); writes.push({ lookup: input }); return lookup; },
    async applySubscription(tx, owner, value) { assert.equal(tx, transaction); assert.equal(owner, scope); writes.push({ applied: value }); return true; },
    async clearPendingCheckout(tx, owner, id) { assert.equal(tx, transaction); assert.equal(owner, scope); writes.push({ cleared: id }); return scope.checkoutSessionId === id; },
    async enqueueEmail(tx, intent) { assert.equal(tx, transaction); intents.push(intent); },
  };
  const gateway = { async getSubscription() { retrievals++; return subscription; } } as unknown as StripeGateway;
  const service = createStripeWebhookService(config, repository, gateway, { logger: { info: fields => logs.push(fields) },
    now: () => new Date("2026-09-27T13:00:00.000Z") });
  return { scope, subscription, writes, intents, claims, logs, repository, gateway, service,
    retrievals: () => retrievals, unknown: () => { lookup = null; } };
}
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
test("six supported events reconcile current Subscription or only clear matching expiration", async () => {
  for (const type of ["checkout.session.completed", "checkout.session.expired", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]) {
    const f = fixture(); if (type.endsWith("deleted")) f.subscription.status = "canceled";
    if (type === "invoice.payment_failed") f.subscription.status = "past_due";
    const result = await f.service.handleEvent(event(type));
    assert.deepEqual(result, { received: true, duplicate: false, ignored: false, providerEventId: "evt_vapt" });
    assert.equal(f.retrievals(), type.endsWith("expired") ? 0 : 1);
    assert.equal(f.intents.length, type.startsWith("invoice.") || type.endsWith("deleted") ? 1 : 0);
    if (!type.endsWith("expired")) {
      const write = f.writes.find(value => typeof value === "object" && value !== null && "applied" in value) as { applied: { planType: string; subscriptionItemId: string; currentPeriodEnd: string; planStatus: string } };
      assert.equal(write.applied.planType, "pro"); assert.equal(write.applied.subscriptionItemId, "si_vapt");
      assert.equal(write.applied.currentPeriodEnd, "2030-01-01T00:00:00.000Z");
      if (type.endsWith("deleted")) assert.equal(write.applied.planStatus, "cancelled");
    }
  }
});
test("terminal duplicate never retrieves provider or enqueues again; initial purchase emits one activation", async () => {
  const f = fixture(); await f.service.handleEvent(event("invoice.paid")); await f.service.handleEvent(event("invoice.paid"));
  assert.equal(f.retrievals(), 1); assert.equal(f.intents.length, 1); assert.equal(f.intents[0]?.emailKind, "subscription_activated");
  assert.equal(f.intents[0]?.billingResourceId, "in_vapt");
});
test("cycle payment owns renewal intent; subscription/Checkout events own none", async () => {
  const f = fixture(); await f.service.handleEvent(event("invoice.paid", { billing_reason: "subscription_cycle" }));
  assert.equal(f.intents[0]?.emailKind, "subscription_renewed");
});
test("in-flight claim stays retryable instead of acknowledging unfinished work", async () => {
  const f = fixture(); f.repository.claimEvent = async () => ({ kind: "in_flight" });
  await assert.rejects(f.service.handleEvent(event("invoice.paid")), error => error instanceof AppError && error.statusCode === 503);
  assert.equal(f.retrievals(), 0);
});
test("unsupported event is durably ignored without state or email", async () => {
  const f = fixture(); assert.equal((await f.service.handleEvent(event("customer.created"))).ignored, true);
  assert.equal(f.retrievals(), 0); assert.equal(f.intents.length, 0); assert.deepEqual(f.writes, [{ outcome: "ignored" }]);
});
test("unknown restaurant association is audited and ignored", async () => {
  const f = fixture(); f.unknown(); assert.equal((await f.service.handleEvent(event("invoice.paid"))).ignored, true);
  assert.ok(!f.writes.some(value => typeof value === "object" && value !== null && "applied" in value)); assert.equal(f.intents.length, 0);
});
test("wrong-mode events and malformed body are rejected before persistence", async () => {
  for (const value of [{ ...event("invoice.paid"), livemode: true }, { id: "evt_bad" }]) {
    const f = fixture(); await assert.rejects(f.service.handleEvent(value), code("invalid_webhook_event")); assert.deepEqual(f.claims, []);
  }
});
test("canonical provider mode, tenant, Customer, Subscription, item count/recurrence and Price are validated", async () => {
  for (const kind of ["mode", "tenant", "owner", "customer", "subscription", "zero", "multiple", "nonrecurring", "price"]) {
    const f = fixture();
    if (kind === "mode") f.subscription.livemode = true;
    if (kind === "tenant") f.subscription.metadata.vapt_restaurant_id = "foreign";
    if (kind === "owner") f.subscription.metadata.vapt_owner_id = "foreign";
    if (kind === "customer") f.subscription.customerId = "cus_foreign";
    if (kind === "subscription") f.subscription.id = "sub_foreign";
    if (kind === "zero") f.subscription.items = [];
    if (kind === "multiple") f.subscription.items.push({ ...f.subscription.items[0], id: "si_second" });
    if (kind === "nonrecurring") f.subscription.items[0].recurring = false;
    if (kind === "price") f.subscription.items[0].priceId = "price_unknown";
    await assert.rejects(f.service.handleEvent(event("invoice.paid")), code("billing_processing_failed"));
    assert.equal(f.intents.length, 0); assert.ok(f.writes.some(value => typeof value === "object" && value !== null && "failed" in value));
  }
});
test("event identifiers/metadata cannot bind to another tenant", async () => {
  const f = fixture(); await assert.rejects(f.service.handleEvent(event("checkout.session.completed", {
    metadata: { ...metadata, vapt_owner_id: "foreign" } })), code("billing_processing_failed"));
  assert.equal(f.intents.length, 0);
});
test("expired old Checkout leaves a different pending Session intact", async () => {
  const f = fixture(); f.scope.checkoutSessionId = "cs_test_newer";
  assert.equal((await f.service.handleEvent(event("checkout.session.expired"))).ignored, true);
  assert.equal(f.intents.length, 0);
});
test("provider and database failures retry safely and later succeed", async () => {
  for (const provider of [true, false]) {
    const f = fixture(); let fail = true;
    if (provider) f.gateway.getSubscription = async () => { if (fail) throw new Error("sk_test_secret card payload"); return f.subscription; };
    else f.repository.applySubscription = async () => { if (fail) throw new Error("postgresql://secret@db payload"); return true; };
    await assert.rejects(f.service.handleEvent(event("invoice.paid")), code("billing_processing_failed"));
    assert.doesNotMatch(JSON.stringify(f.logs), /secret|payload|card|postgresql/);
    const failed = f.writes.find(value => typeof value === "object" && value !== null && "failed" in value) as { failed: { errorCode: string } };
    assert.equal(failed.failed.errorCode, "billing_processing_failed");
    fail = false; await f.service.handleEvent(event("invoice.paid")); assert.equal(f.intents.length, 1);
  }
});
test("event audit payload and email intent omit raw URLs, email/card data and untrusted metadata", async () => {
  const f = fixture(); await f.service.handleEvent(event("invoice.paid", { customer_email: "private@example.com", hosted_invoice_url: "https://secret.example", payment_method: "card_secret" }));
  assert.doesNotMatch(JSON.stringify([...f.claims, ...f.intents, ...f.logs]), /private@example|secret.example|card_secret/);
});
test("host clock skew never discards canonical state read under the restaurant lock", async () => {
  const f = fixture(); f.scope.stateUpdatedAt = "2026-09-27T14:00:00.000Z";
  f.subscription.status = "canceled";
  assert.equal((await f.service.handleEvent(event("customer.subscription.deleted"))).ignored, false);
  assert.equal(f.intents.length, 1);
});
test("canonical retrieval follows the restaurant lock so concurrent events cannot overwrite a newer snapshot", async () => {
  const f = fixture();
  f.gateway.getSubscription = async () => {
    assert.ok(f.writes.some(value => typeof value === "object" && value !== null && "lookup" in value), "restaurant must be locked first");
    return f.subscription;
  };
  await f.service.handleEvent(event("invoice.paid"));
});
test("replacement Checkout can bind a new Subscription only after the previous canonical one is terminal", async () => {
  for (const terminal of [false, true]) {
    const f = fixture(); f.scope.stripeSubscriptionId = "sub_previous"; f.scope.planStatus = "active";
    f.gateway.getSubscription = async id => id === "sub_previous" ? { ...f.subscription, id, status: terminal ? "canceled" : "active" } : f.subscription;
    if (terminal) await f.service.handleEvent(event("checkout.session.completed"));
    else await assert.rejects(f.service.handleEvent(event("checkout.session.completed")), code("billing_processing_failed"));
  }
});
for (const type of ["checkout.session.completed", "checkout.session.expired", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]) {
  test(`${type} validates metadata/customer, unknown restaurant, duplicate and safe retry`, async () => {
    const f = fixture(); if (type.endsWith("deleted")) f.subscription.status = "canceled";
    const first = event(type); await f.service.handleEvent(first);
    assert.equal((await f.service.handleEvent(first)).duplicate, true);
    const unknown = fixture(); unknown.unknown(); assert.equal((await unknown.service.handleEvent(first)).ignored, true);
    const foreign = fixture(); foreign.scope.stripeCustomerId = "cus_foreign";
    await assert.rejects(foreign.service.handleEvent(first), code("billing_processing_failed"));
    const mismatched = fixture();
    const invalid = type.startsWith("invoice.") ? event(type, { parent: { subscription_details: {
      subscription: "sub_vapt", metadata: { ...metadata, vapt_owner_id: "foreign" } } } }) :
      event(type, { metadata: { ...metadata, vapt_owner_id: "foreign" } });
    await assert.rejects(mismatched.service.handleEvent(invalid), code("billing_processing_failed"));
    const retry = fixture(); let fail = true;
    if (type.endsWith("expired")) retry.repository.clearPendingCheckout = async () => { if (fail) throw new Error("private database detail"); return true; };
    else retry.gateway.getSubscription = async () => { if (fail) throw new Error("private provider detail"); return { ...retry.subscription, status: type.endsWith("deleted") ? "canceled" : "active" }; };
    await assert.rejects(retry.service.handleEvent(first), code("billing_processing_failed"));
    fail = false; await retry.service.handleEvent(first);
    assert.doesNotMatch(JSON.stringify(retry.logs), /private|provider detail|database detail/);
  });
}
