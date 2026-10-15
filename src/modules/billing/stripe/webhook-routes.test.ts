import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import Stripe from "stripe";
import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import { registerErrorHandler } from "../../../plugins/error-handler.js";
import { registerRawBody } from "../../../plugins/raw-body.js";
import { createStripeClient, constructStripeWebhookEvent } from "./client.js";
import { registerStripeWebhookRoutes } from "./webhook-routes.js";

const config = { stripe: { secretKey: "sk_test_vapt", webhookSecret: "whsec_test", webhookToleranceSeconds: 300,
  environment: "test", portalConfigurationId: "bpc_vapt", prices: { starter: "price_starter", pro: "price_pro", business: "price_business" } } } as AppConfig;
const result = { received: true, duplicate: false, ignored: false, providerEventId: "evt_route" };
const raw = '{\n "id": "evt_route", "type": "invoice.paid", "created": 1790500000, "livemode": false, "data": { "object": {} }\n}\n';
const client = createStripeClient(config.stripe, { fetchImpl: async () => { throw new Error("Signature verification must not call Stripe"); } });
async function setup(options: { rawPlugin?: boolean; failure?: boolean } = {}) {
  const app = Fastify({ logger: false }); registerErrorHandler(app);
  if (options.rawPlugin !== false) await registerRawBody(app);
  const verified: string[] = []; const handled: unknown[] = [];
  await registerStripeWebhookRoutes(app, config, {
    constructEvent: async (body, signature) => { verified.push(body); return constructStripeWebhookEvent(client, body, signature, config.stripe); },
    service: { async handleEvent(event) { handled.push(event);
      if (options.failure) throw new AppError(500, "billing_processing_failed", "Billing event will be retried"); return result; } },
  });
  return { app, verified, handled };
}
async function signature(timestamp = Math.floor(Date.now() / 1000)) {
  return client.webhooks.generateTestHeaderStringAsync({ payload: raw, secret: config.stripe.webhookSecret,
    timestamp, cryptoProvider: Stripe.createSubtleCryptoProvider() });
}
test("webhook verifies the exact raw body, including whitespace, before handing event to service", async () => {
  const f = await setup(); const response = await f.app.inject({ method: "POST", url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": await signature() }, payload: raw });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), result);
  assert.deepEqual(f.verified, [raw]); assert.equal(f.handled.length, 1); await f.app.close();
});
test("missing/invalid/expired signatures are rejected without persisting events", async () => {
  for (const value of [undefined, "t=1,v1=invalid", await signature(Math.floor(Date.now() / 1000) - 301)]) {
    const f = await setup(); const response = await f.app.inject({ method: "POST", url: "/webhooks/stripe",
      headers: { "content-type": "application/json", ...(value ? { "stripe-signature": value } : {}) }, payload: raw });
    assert.equal(response.statusCode, 401); assert.deepEqual(f.handled, []);
    assert.doesNotMatch(response.body, /whsec|v1=|StripeSignatureVerificationError/); await f.app.close();
  }
});
test("missing raw-body plugin cannot fall back to serialized parsed JSON", async () => {
  const f = await setup({ rawPlugin: false }); const response = await f.app.inject({ method: "POST", url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": await signature() }, payload: raw });
  assert.equal(response.statusCode, 400); assert.deepEqual(f.verified, []); assert.deepEqual(f.handled, []); await f.app.close();
});
test("malformed JSON and unsupported content type are rejected safely", async () => {
  for (const contentType of ["application/json", "text/plain"]) {
    const f = await setup(); const response = await f.app.inject({ method: "POST", url: "/webhooks/stripe",
      headers: { "content-type": contentType, "stripe-signature": "signature_secret" }, payload: "{bad" });
    assert.equal(response.statusCode, 400); assert.deepEqual(f.handled, []); assert.doesNotMatch(response.body, /signature_secret|bad/); await f.app.close();
  }
});
test("processing failure returns retryable 500 instead of acknowledging success", async () => {
  const f = await setup({ failure: true }); const response = await f.app.inject({ method: "POST", url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": await signature() }, payload: raw });
  assert.equal(response.statusCode, 500); assert.equal(response.json().error.code, "billing_processing_failed"); await f.app.close();
});
