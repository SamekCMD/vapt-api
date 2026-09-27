import assert from "node:assert/strict";
import test from "node:test";

import Stripe from "stripe";

import type { StripeBillingConfig } from "../../../lib/config.js";
import {
  STRIPE_API_VERSION,
  constructStripeWebhookEvent,
  createStripeClient,
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
