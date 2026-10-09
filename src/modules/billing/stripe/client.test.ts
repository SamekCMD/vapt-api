import assert from "node:assert/strict";
import test from "node:test";

import Stripe from "stripe";

import type { StripeBillingConfig } from "../../../lib/config.js";
import {
  STRIPE_API_VERSION,
  constructStripeWebhookEvent,
  createStripeClient,
  createStripeGateway,
} from "./client.js";

const config: StripeBillingConfig = {
  secretKey: "sk_test_vapt",
  webhookSecret: "whsec_vapt",
  webhookToleranceSeconds: 300,
  environment: "test",
  portalConfigurationId: "bpc_vapt",
  prices: {
    starter: "price_starter",
    pro: "price_pro",
    business: "price_business",
  },
};

test("createStripeClient pins the reviewed API version and uses fetch transport", async () => {
  let observedRequest: { url: string; method: string | undefined } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    observedRequest = {
      url: String(input),
      method: init?.method,
    };

    return new Response(
      JSON.stringify({
        id: "cus_worker",
        object: "customer",
        livemode: false,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "req_worker",
        },
      },
    );
  };

  const client = createStripeClient(config, { fetchImpl });
  const customer = await client.customers.retrieve("cus_worker");

  assert.equal(STRIPE_API_VERSION, "2026-08-26.dahlia");
  assert.equal(customer.id, "cus_worker");
  assert.equal(observedRequest?.method, "GET");
  assert.match(observedRequest?.url ?? "", /\/v1\/customers\/cus_worker$/);
});

test("gateway sends trusted hosted Checkout fields and idempotency as request options via SDK", async () => {
  const requests: Array<{ path: string; body: URLSearchParams; key: string | null }> = [];
  const metadata = { vapt_restaurant_id: "restaurant-1", vapt_owner_id: "owner-1", vapt_plan_type: "pro" };
  const client = createStripeClient(config, { fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = new URLSearchParams(String(init?.body ?? ""));
    requests.push({ path, body, key: new Headers(init?.headers).get("idempotency-key") });
    const payload = path === "/v1/customers/search" ? { data: [], has_more: false } :
      path === "/v1/customers" ? { id: "cus_vapt", livemode: false, metadata } :
      { id: "cs_test_vapt", mode: "subscription", status: "open", livemode: false, metadata,
        customer: "cus_vapt", subscription: null, client_reference_id: "restaurant-1",
        url: "https://checkout.stripe.com/c/pay/vapt", expires_at: 1917043200 };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const gateway = createStripeGateway(client);
  assert.deepEqual(await gateway.findCustomers("restaurant-1"), []);
  await gateway.createCustomer({ email: "owner@example.com", metadata }, "vapt:customer:restaurant-1");
  await gateway.createCheckout({ customerId: "cus_vapt", priceId: "price_pro", metadata,
    clientReferenceId: "restaurant-1", successUrl: "https://app.vapt.test/returned", cancelUrl: "https://app.vapt.test/cancelled" }, "checkout-key");
  assert.equal(requests[1]?.key, "vapt:customer:restaurant-1");
  assert.equal(requests[2]?.key, "checkout-key");
  const body = requests[2]!.body;
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("customer"), "cus_vapt");
  assert.equal(body.get("line_items[0][price]"), "price_pro");
  assert.equal(body.get("line_items[0][quantity]"), "1");
  for (const [key, value] of Object.entries(metadata)) {
    assert.equal(body.get(`metadata[${key}]`), value);
    assert.equal(body.get(`subscription_data[metadata][${key}]`), value);
  }
  assert.equal(body.get("client_reference_id"), "restaurant-1");
  assert.equal(body.get("success_url"), "https://app.vapt.test/returned");
  assert.equal(body.get("cancel_url"), "https://app.vapt.test/cancelled");
  assert.equal(body.has("idempotencyKey"), false);
});

test("gateway sanitizes real SDK errors without retaining Stripe request data", async () => {
  const gateway = createStripeGateway(createStripeClient(config, { fetchImpl: async () =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "sk_test_secret raw card payload" } }),
      { status: 400, headers: { "content-type": "application/json" } }) }));
  await assert.rejects(gateway.getCustomer("cus_vapt"), error => error instanceof Error &&
    "code" in error && error.code === "stripe_unavailable" && !/secret|card|payload/.test(JSON.stringify(error)));
});

test("gateway recognizes Portal end-of-period cancellation when Stripe sets cancel_at only", async () => {
  const currentPeriodEnd = 1793123057;
  const client = createStripeClient(config, { fetchImpl: async () => new Response(JSON.stringify({
    id: "sub_portal", object: "subscription", livemode: false, metadata: {},
    customer: "cus_portal", status: "active", trial_end: null,
    canceled_at: 1790546539, cancel_at: currentPeriodEnd, cancel_at_period_end: false,
    items: { object: "list", has_more: false, data: [{
      id: "si_portal", object: "subscription_item", current_period_end: currentPeriodEnd,
      price: { id: "price_pro", recurring: { interval: "month", interval_count: 1 } },
    }] },
  }), { status: 200, headers: { "content-type": "application/json" } }) });

  const subscription = await createStripeGateway(client).getSubscription("sub_portal");

  assert.equal(subscription.status, "active");
  assert.equal(subscription.cancelAtPeriodEnd, true);
  assert.equal(subscription.items[0]?.currentPeriodEnd, "2026-10-27T17:44:17.000Z");
});

test("constructStripeWebhookEvent verifies signatures with Web Crypto asynchronously", async () => {
  const client = createStripeClient(config, {
    fetchImpl: async () => {
      throw new Error("webhook verification must not call the network");
    },
  });
  const payload = JSON.stringify({
    id: "evt_worker",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: "cs_test_worker", object: "checkout.session" } },
  });
  const signature = await client.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: config.webhookSecret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });

  const event = await constructStripeWebhookEvent(
    client,
    payload,
    signature,
    config,
  );

  assert.equal(event.id, "evt_worker");
  await assert.rejects(
    constructStripeWebhookEvent(client, payload, "t=1,v1=invalid", config),
    /signature/i,
  );
});
