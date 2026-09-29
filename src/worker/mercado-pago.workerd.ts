import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createTestHarness } from "wrangler";

const orderId = "10000000-0000-4000-8000-000000000011";
const transactionId = "10000000-0000-4000-8000-000000000031";

test("Mercado Pago remains optional while manual payment is always routed", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const disabledOAuth = await fixture.fetch(`${base}/payments/mercado-pago/oauth/callback?state=synthetic-state-123456&code=code`);
    assert.equal(disabledOAuth.status, 404);
    const productionDiagnostics = await fixture.fetch(`${base}/public/orders/${orderId}/payments/${transactionId}/diagnostics`);
    assert.equal(productionDiagnostics.status, 404);
    const manualWithoutMercadoPago = await fixture.fetch(`${base}/orders/${orderId}/payments/manual-confirmation`, { method: "POST" });
    assert.equal(manualWithoutMercadoPago.status, 401);
  } finally {
    await server.close();
  }
});

test("enabled Mercado Pago preserves redirects, checkout, and both signed webhook paths", async () => {
  const server = createTestHarness({ workers: [
    { configPath: "./wrangler.worker-test-mp.jsonc" },
    { configPath: "./wrangler.worker-test-mp-production.jsonc" },
  ] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-mp-test");
    const base = "https://api.vapt.test";
    const token = "synthetic-public-order-token-1234567890";
    const checkout = await fixture.fetch(`${base}/public/orders/${orderId}/payments/checkout`, {
      method: "POST", headers: {
        "content-type": "application/json", "idempotency-key": "synthetic-checkout",
        "x-vapt-order-token": token,
      }, body: JSON.stringify({ returnOrigin: "https://app.vapt.test" }),
    });
    assert.equal(checkout.status, 200);
    assert.equal((await checkout.json() as { transactionId: string }).transactionId, transactionId);
    const missingCheckoutToken = await fixture.fetch(`${base}/public/orders/${orderId}/payments/checkout`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "synthetic-checkout" }, body: "{}",
    });
    assert.equal(missingCheckoutToken.status, 400);
    const missingIdempotency = await fixture.fetch(`${base}/public/orders/${orderId}/payments/checkout`, {
      method: "POST", headers: { "content-type": "application/json", "x-vapt-order-token": token }, body: "{}",
    });
    assert.equal(missingIdempotency.status, 400);
    const diagnostics = await fixture.fetch(`${base}/public/orders/${orderId}/payments/${transactionId}/diagnostics`, {
      headers: { "x-vapt-order-token": token },
    });
    assert.equal(diagnostics.status, 200);
    const productionDiagnostics = await server.getWorker("vapt-api-worker-mp-production-test")
      .fetch(`${base}/public/orders/${orderId}/payments/${transactionId}/diagnostics`, {
        headers: { "x-vapt-order-token": token },
      });
    assert.equal(productionDiagnostics.status, 404);

    const restaurantId = "10000000-0000-4000-8000-000000000001";
    const connect = await fixture.fetch(`${base}/restaurants/${restaurantId}/payments/mercado-pago/connect`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json" },
      body: JSON.stringify({ environment: "sandbox", returnOrigin: "https://app.vapt.test" }),
    });
    assert.equal(connect.status, 200);
    const status = await fixture.fetch(`${base}/restaurants/${restaurantId}/payments/mercado-pago/status?environment=sandbox`, {
      headers: { cookie: "session=owner" },
    });
    assert.equal(status.status, 200);
    const disconnect = await fixture.fetch(`${base}/restaurants/${restaurantId}/payments/mercado-pago/connection?environment=sandbox`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(disconnect.status, 200);
    const callback = await fixture.fetch(`${base}/payments/mercado-pago/oauth/callback?state=synthetic-state-123456&code=code`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") ?? "", /connection=connected/);
    const browserReturn = await fixture.fetch(`${base}/payments/mercado-pago/return?result=success&payment_id=12345&external_reference=${transactionId}&return_origin=https%3A%2F%2Fapp.vapt.test`, {
      redirect: "manual",
    });
    assert.equal(browserReturn.status, 302);
    assert.match(browserReturn.headers.get("location") ?? "", /result=success/);

    const raw = JSON.stringify({ id: "mp_evt_synthetic", type: "payment", action: "payment.updated", data: { id: "12345" } }, null, 2);
    const requestId = "synthetic-request";
    const timestamp = "1790500000";
    const digest = createHmac("sha256", "synthetic-webhook-secret")
      .update(`id:12345;request-id:${requestId};ts:${timestamp};`).digest("hex");
    const signedHeaders = {
      "content-type": "application/json", "x-request-id": requestId,
      "x-signature": `ts=${timestamp},v1=${digest}`,
    };
    const canonical = await fixture.fetch(`${base}/webhooks/payments/mercado-pago?data.id=12345`, {
      method: "POST", headers: signedHeaders, body: raw,
    });
    assert.equal(canonical.status, 200);
    assert.deepEqual(await canonical.json(), { received: true, duplicate: false, ignored: true });
    const alias = await fixture.fetch(`${base}/payments/mercado-pago/webhook?data.id=12345`, {
      method: "POST", headers: signedHeaders, body: raw,
    });
    assert.equal(alias.status, 200);
    assert.deepEqual(await alias.json(), { received: true, duplicate: true });
    const badSignature = await fixture.fetch(`${base}/webhooks/payments/mercado-pago?data.id=12345`, {
      method: "POST", headers: { ...signedHeaders, "x-signature": "bad" }, body: raw,
    });
    assert.equal(badSignature.status, 401);
    const missingSignature = await fixture.fetch(`${base}/webhooks/payments/mercado-pago?data.id=12345`, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: raw,
    });
    assert.equal(missingSignature.status, 401);
    const wrongType = await fixture.fetch(`${base}/webhooks/payments/mercado-pago?data.id=12345`, {
      method: "POST", headers: { ...signedHeaders, "content-type": "text/plain" }, body: raw,
    });
    assert.equal(wrongType.status, 400);
    const counts = await fixture.fetch(`${base}/_test/mercado-pago-counts`);
    assert.deepEqual(await counts.json(), {
      mercadoPagoWebhookCalls: 2, mercadoPagoSideEffects: 1, mercadoPagoRawBody: raw,
    });
  } finally {
    await server.close();
  }
});
