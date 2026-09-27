import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import { registerAuthDecorator } from "../../../plugins/auth.js";
import { registerErrorHandler } from "../../../plugins/error-handler.js";
import type { BillingScope, StripeBillingStore } from "./repository.js";
import { createStripeBillingService } from "./service.js";
import { registerStripeBillingRoutes } from "./routes.js";
import type { StripeGateway, StripeCheckoutSession, StripeSubscription } from "./types.js";

const config = { nodeEnv: "test", frontendUrl: new URL("https://app.vapt.test"),
  stripe: { secretKey: "sk_test_vapt", webhookSecret: "whsec_vapt", webhookToleranceSeconds: 300,
    environment: "test", portalConfigurationId: "bpc_vapt",
    prices: { starter: "price_starter", pro: "price_pro", business: "price_business" } },
} as AppConfig;
const owned = { userId: "owner-1", restaurantId: "restaurant-1" };
const metadata = { vapt_restaurant_id: owned.restaurantId, vapt_owner_id: owned.userId, vapt_plan_type: "pro" };
const input = { ...owned, email: "owner@example.com", planType: "pro" as const,
  idempotencyKey: "a9d1b2c3-1234-4321-9876-0123456789ab" };
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
function fixture(initial: Partial<BillingScope> = {}, authorized = true) {
  const scope: BillingScope = { ...owned, planType: "starter", planStatus: "trialing", stripeCustomerId: null,
    stripeSubscriptionId: null, trialEndsAt: "2026-10-01T00:00:00Z", currentPeriodEnd: null,
    cancelAtPeriodEnd: false, subscriptionCanceledAt: null, checkoutSessionId: null,
    checkoutPlanType: null, checkoutExpiresAt: null, ...initial };
  const calls: Array<{ name: string; input?: unknown; key?: string }> = [];
  let locked = false;
  const customer = { id: "cus_vapt", livemode: false, metadata: { ...metadata } };
  const session: StripeCheckoutSession = { id: "cs_test_vapt", livemode: false, metadata: { ...metadata },
    customerId: customer.id, subscriptionId: null, status: "open", clientReferenceId: owned.restaurantId,
    url: "https://checkout.stripe.com/c/pay/vapt", expiresAt: "2030-10-01T00:00:00.000Z" };
  const subscription: StripeSubscription = { id: "sub_vapt", livemode: false, metadata: { ...metadata },
    customerId: customer.id, status: "active", items: [], trialEndsAt: null, canceledAt: null, cancelAtPeriodEnd: false };
  const gateway: StripeGateway = {
    async findCustomers(id) { assert.ok(locked); calls.push({ name: "search", input: id }); return []; },
    async getCustomer(id) { calls.push({ name: "customer", input: id }); return { ...customer, id }; },
    async createCustomer(value, key) { assert.ok(locked); calls.push({ name: "createCustomer", input: value, key }); return customer; },
    async getCheckout(id) { assert.ok(locked); calls.push({ name: "getCheckout", input: id }); return session; },
    async createCheckout(value, key) { assert.ok(locked); calls.push({ name: "checkout", input: value, key }); return session; },
    async createPortal(value) { calls.push({ name: "portal", input: value }); return { url: "https://billing.stripe.com/p/session/vapt", customerId: customer.id, livemode: false }; },
    async getSubscription(id) { calls.push({ name: "subscription", input: id }); return subscription; },
  };
  const publicStatus = { planType: scope.planType, planStatus: scope.planStatus, trialEndsAt: scope.trialEndsAt,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionCanceledAt: null,
    canManageBilling: scope.stripeCustomerId !== null, requiresBillingAction: false };
  const store: StripeBillingStore = {
    async getScope() { return scope; }, async getPublicStatus() { return publicStatus; },
    async withBillingLock(value, work) {
      assert.deepEqual(value, owned); locked = true;
      try { return await work({ scope,
        async associateCustomer(id) { calls.push({ name: "associate", input: id }); scope.stripeCustomerId = id; },
        async savePendingCheckout(pending) { calls.push({ name: "save", input: pending }); scope.checkoutSessionId = pending.id; scope.checkoutPlanType = pending.planType; scope.checkoutExpiresAt = pending.expiresAt; },
        async clearPendingCheckout() { calls.push({ name: "clear" }); },
      }); } finally { locked = false; }
    },
  };
  return { scope, calls, customer, session, subscription, gateway, store, publicStatus,
    service: () => createStripeBillingService(gateway, async () => authorized, store, config) };
}
test("checkout authorizes before provider operations", async () => {
  const f = fixture({}, false); await assert.rejects(f.service().createCheckout(input), code("forbidden")); assert.deepEqual(f.calls, []);
});
test("free local trial creates trusted hosted Checkout under lock without activating entitlement", async () => {
  const f = fixture(); assert.deepEqual(await f.service().createCheckout(input), { checkoutSessionId: f.session.id, url: f.session.url });
  assert.deepEqual(f.calls.map(c => c.name), ["search", "createCustomer", "associate", "checkout", "save"]);
  assert.deepEqual(f.calls[1], { name: "createCustomer", input: { email: input.email, metadata }, key: "vapt:customer:restaurant-1" });
  assert.deepEqual(f.calls[3], { name: "checkout", input: { customerId: "cus_vapt", priceId: "price_pro", metadata,
    clientReferenceId: owned.restaurantId, successUrl: "https://app.vapt.test/dashboard/subscription?checkout=returned",
    cancelUrl: "https://app.vapt.test/dashboard/subscription?checkout=cancelled" }, key: "vapt:checkout:restaurant-1:pro:" + input.idempotencyKey });
  assert.equal(f.scope.planType, "starter"); assert.equal(f.scope.planStatus, "trialing"); assert.equal(f.scope.stripeSubscriptionId, null);
});
test("existing Customer is validated/reused and interrupted association is recovered", async () => {
  const f = fixture({ stripeCustomerId: "cus_vapt" }); await f.service().createCheckout(input);
  assert.deepEqual(f.calls.map(c => c.name), ["customer", "checkout", "save"]);
  const recovered = fixture(); recovered.gateway.findCustomers = async () => [recovered.customer]; await recovered.service().createCheckout(input);
  assert.deepEqual(recovered.calls.map(c => c.name), ["associate", "checkout", "save"]);
});
test("ambiguous Customer metadata fails closed", async () => {
  const f = fixture(); f.gateway.findCustomers = async () => [f.customer, { ...f.customer, id: "cus_duplicate" }];
  await assert.rejects(f.service().createCheckout(input), code("billing_conflict")); assert.deepEqual(f.calls, []);
});
test("same-plan open Checkout reused; other plan or completed pending Checkout conflicts", async () => {
  for (const status of ["open", "different", "complete"]) {
    const f = fixture({ stripeCustomerId: "cus_vapt", checkoutSessionId: "cs_test_vapt", checkoutPlanType: status === "different" ? "starter" : "pro", checkoutExpiresAt: "2020-01-01T00:00:00Z" });
    if (status === "complete") f.session.status = "complete";
    if (status === "different") f.session.metadata.vapt_plan_type = "starter";
    if (status === "open") await f.service().createCheckout(input);
    else await assert.rejects(f.service().createCheckout(input), code("billing_conflict"));
    assert.deepEqual(f.calls.map(c => c.name), ["customer", "getCheckout"]);
  }
});
test("expired pending Checkout is replaced", async () => {
  const f = fixture({ stripeCustomerId: "cus_vapt", checkoutSessionId: "cs_test_vapt", checkoutPlanType: "pro", checkoutExpiresAt: "2020-01-01T00:00:00Z" });
  f.gateway.getCheckout = async () => ({ ...f.session, status: "expired" }); await f.service().createCheckout(input);
  assert.deepEqual(f.calls.map(c => c.name), ["customer", "clear", "checkout", "save"]);
});
test("canonical nonterminal subscriptions block duplicates; terminal subscriptions permit replacement", async () => {
  for (const status of ["active", "trialing", "past_due", "incomplete", "unpaid", "paused", "canceled", "incomplete_expired"] as const) {
    const f = fixture({ stripeCustomerId: "cus_vapt", stripeSubscriptionId: "sub_vapt" }); f.subscription.status = status;
    if (["canceled", "incomplete_expired"].includes(status)) await f.service().createCheckout(input);
    else await assert.rejects(f.service().createCheckout(input), code("billing_conflict"));
  }
});
test("foreign tenant and wrong mode Customers fail closed", async () => {
  for (const wrongMode of [false, true]) {
    const f = fixture({ stripeCustomerId: "cus_vapt" }); f.gateway.getCustomer = async () => ({ ...f.customer, livemode: wrongMode,
      metadata: wrongMode ? metadata : { ...metadata, vapt_owner_id: "foreign" } });
    await assert.rejects(f.service().createCheckout(input), code("invalid_stripe_response"));
  }
});
test("Checkout rejects wrong mode, Customer, tenant, plan and insecure or foreign URL", async () => {
  for (const invalid of [{ livemode: true }, { customerId: "cus_foreign" }, { metadata: { ...metadata, vapt_restaurant_id: "foreign" } },
    { metadata: { ...metadata, vapt_plan_type: "business" } }, { url: "http://checkout.stripe.com/vapt" },
    { url: "https://evil.example/vapt" }, { url: "https://user:password@checkout.stripe.com/vapt" }]) {
    const f = fixture(); Object.assign(f.session, invalid);
    await assert.rejects(f.service().createCheckout(input), code("invalid_stripe_response")); assert.ok(!f.calls.some(c => c.name === "save"));
  }
});
test("Checkout requires a bounded request idempotency key", async () => {
  for (const idempotencyKey of ["", "bad key", "x".repeat(129)]) {
    const f = fixture(); await assert.rejects(f.service().createCheckout({ ...input, idempotencyKey }), code("invalid_request")); assert.deepEqual(f.calls, []);
  }
});
test("Portal uses server-owned Customer, configuration and return URL", async () => {
  const f = fixture({ stripeCustomerId: "cus_vapt" }); assert.deepEqual(await f.service().createPortal(owned), { url: "https://billing.stripe.com/p/session/vapt" });
  assert.deepEqual(f.calls.at(-1), { name: "portal", input: { customerId: "cus_vapt", configurationId: "bpc_vapt", returnUrl: "https://app.vapt.test/dashboard/subscription" } });
  await assert.rejects(fixture().service().createPortal(owned), code("billing_conflict"));
  await assert.rejects(fixture({}, false).service().createPortal(owned), code("forbidden"));
});
test("Portal rejects insecure URL, wrong mode or mismatched Customer", async () => {
  for (const invalid of [{ url: "http://billing.stripe.com/vapt" }, { livemode: true }, { customerId: "cus_foreign" }]) {
    const f = fixture({ stripeCustomerId: "cus_vapt" }); f.gateway.createPortal = async () => ({ url: "https://billing.stripe.com/p/session/vapt", livemode: false, customerId: "cus_vapt", ...invalid });
    await assert.rejects(f.service().createPortal(owned), code("invalid_stripe_response"));
  }
});
test("raw provider failure never reaches response or logs", async () => {
  const f = fixture(); f.gateway.createCheckout = async () => { throw new Error("sk_test_secret raw card payload"); };
  await assert.rejects(f.service().createCheckout(input), error => error instanceof AppError && error.code === "stripe_unavailable" && !/secret|card|payload/.test(JSON.stringify(error)));
});
test("status returns server snapshot without provider call", async () => {
  const f = fixture(); assert.deepEqual(await f.service().getSubscriptionStatus(owned), f.publicStatus); assert.deepEqual(f.calls, []);
});
test("routes require cookie auth and strict body, then expose hosted contracts; legacy mutations return 404", async () => {
  const f = fixture(); const app = Fastify(); registerErrorHandler(app);
  registerAuthDecorator(app, async headers => headers.cookie === "session=valid" ? { userId: owned.userId, email: input.email, role: "authenticated" } : null);
  await registerStripeBillingRoutes(app, config, async () => true, f.store, f.gateway);
  const request = (payload: Record<string, unknown>, auth = true) => app.inject({ method: "POST", url: "/billing/stripe/checkout", headers: { ...(auth ? { cookie: "session=valid" } : {}), "idempotency-key": input.idempotencyKey }, payload });
  assert.equal((await request({ restaurantId: owned.restaurantId, planType: "pro" }, false)).statusCode, 401);
  for (const extra of [{ email: "attacker" }, { priceId: "price_evil" }, { successUrl: "https://evil.example" }, { customerId: "cus_evil" }])
    assert.equal((await request({ restaurantId: owned.restaurantId, planType: "pro", ...extra })).statusCode, 400);
  const result = await request({ restaurantId: owned.restaurantId, planType: "pro" }); assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { checkoutSessionId: "cs_test_vapt", url: f.session.url });
  const portal = await app.inject({ method: "POST", url: "/billing/stripe/portal", headers: { cookie: "session=valid" }, payload: { restaurantId: owned.restaurantId } });
  assert.equal(portal.statusCode, 200); assert.deepEqual(portal.json(), { url: "https://billing.stripe.com/p/session/vapt" });
  const status = await app.inject({ url: "/billing/stripe/subscription?restaurantId=restaurant-1", headers: { cookie: "session=valid" } }); assert.deepEqual(status.json(), f.publicStatus);
  for (const operation of ["change", "cancel"]) assert.equal((await app.inject({ method: "POST", url: "/billing/stripe/subscription/" + operation, headers: { cookie: "session=valid" }, payload: { restaurantId: owned.restaurantId, ...(operation === "change" ? { targetPlanType: "pro" } : {}) } })).statusCode, 404);
  await app.close();
});
