import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { createTestHarness } from "wrangler";

test("Stripe Worker routes protect billing and verify the untouched webhook body", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const checkout = await fixture.fetch(`${base}/billing/stripe/checkout`, { method: "POST" });
    assert.equal(checkout.status, 401);
    const portal = await fixture.fetch(`${base}/billing/stripe/portal`, { method: "POST" });
    assert.equal(portal.status, 401);
    const subscription = await fixture.fetch(`${base}/billing/stripe/subscription`);
    assert.equal(subscription.status, 401);
    const ownedRestaurant = "10000000-0000-4000-8000-000000000001";
    const foreignRestaurant = "10000000-0000-4000-8000-000000000002";
    const ownedCheckout = await fixture.fetch(`${base}/billing/stripe/checkout`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json", "idempotency-key": "synthetic-checkout" },
      body: JSON.stringify({ restaurantId: ownedRestaurant, planType: "pro" }),
    });
    assert.equal(ownedCheckout.status, 200);
    const crossTenant = await fixture.fetch(`${base}/billing/stripe/checkout`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json", "idempotency-key": "synthetic-checkout" },
      body: JSON.stringify({ restaurantId: foreignRestaurant, planType: "pro" }),
    });
    assert.equal(crossTenant.status, 403);
    const missingIdempotency = await fixture.fetch(`${base}/billing/stripe/checkout`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json" },
      body: JSON.stringify({ restaurantId: ownedRestaurant, planType: "pro" }),
    });
    assert.equal(missingIdempotency.status, 400);

    const raw = JSON.stringify({ id: "evt_synthetic", type: "customer.created", created: 1790500000,
      livemode: false, data: { object: { id: "cus_synthetic", object: "customer" } } }, null, 2);
    const client = new Stripe("sk_test_synthetic", { apiVersion: "2026-08-26.dahlia" });
    const signature = await client.webhooks.generateTestHeaderStringAsync({
      payload: raw, secret: "whsec_synthetic", cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    const valid = await fixture.fetch(`${base}/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: raw,
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { received: true, duplicate: false, ignored: true, providerEventId: "evt_synthetic" });
    const duplicate = await fixture.fetch(`${base}/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: raw,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { received: true, duplicate: true, ignored: true, providerEventId: "evt_synthetic" });

    const invalidSignature = await fixture.fetch(`${base}/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": "invalid" }, body: raw,
    });
    assert.equal(invalidSignature.status, 401);
    const wrongContentType = await fixture.fetch(`${base}/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "text/plain", "stripe-signature": signature }, body: raw,
    });
    assert.equal(wrongContentType.status, 400);
    const malformedRaw = '{"id":';
    const malformedSignature = await client.webhooks.generateTestHeaderStringAsync({
      payload: malformedRaw, secret: "whsec_synthetic", cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    const malformed = await fixture.fetch(`${base}/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": malformedSignature },
      body: malformedRaw,
    });
    assert.equal(malformed.status, 400);
    const counts = await fixture.fetch(`${base}/_test/stripe-counts`);
    assert.deepEqual(await counts.json(), { stripeWebhookCalls: 2, stripeSideEffects: 1 });
  } finally {
    await server.close();
  }
});
