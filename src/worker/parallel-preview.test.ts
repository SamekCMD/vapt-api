import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { ExecutionContext } from "hono";

import type { WorkerBindings } from "./environment.js";
import { handleParallelPreview } from "./parallel-preview.js";

const secret = randomBytes(32).toString("hex");
const context = {} as ExecutionContext;
const env: WorkerBindings & { PARALLEL_PREVIEW_TOKEN?: string } = {
  ENVIRONMENT: "preview",
  PARALLEL_PREVIEW_TOKEN: secret,
};

test("upgrade without operator bearer is denied before socket delegate", async () => {
  let called = false;
  const response = await handleParallelPreview(new Request("https://preview.vapt.test/v1/realtime/restaurants/11111111-1111-4111-8111-111111111111/socket", {
    headers: { Upgrade: "websocket", Origin: "https://app.vapt.test", "Sec-WebSocket-Protocol": "vapt.realtime.v1, vapt.ticket.synthetic" },
  }), env, context, async () => { called = true; return new Response(); });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

function request(authorization?: string): Request {
  return new Request("https://preview.vapt.test/health", {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

test("missing or malformed bearer never invokes the API", async () => {
  let calls = 0;
  const delegate = async () => {
    calls += 1;
    return Response.json({ status: "ok" });
  };
  const duplicate = request(`Bearer ${secret}`);
  duplicate.headers.append("authorization", `Bearer ${secret}`);

  for (const input of [
    request(),
    request("Basic credentials"),
    request("Bearer wrong-token"),
    request(`bearer ${secret}`),
    request(`Bearer ${"x".repeat(300)}`),
    duplicate,
  ]) {
    const response = await handleParallelPreview(input, env, context, delegate);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
  }
  assert.equal(calls, 0);
});

test("missing secret or non-preview environment fails closed before API dispatch", async () => {
  let calls = 0;
  const delegate = async () => {
    calls += 1;
    return Response.json({ status: "ok" });
  };
  for (const bindings of [
    { ENVIRONMENT: "preview" } as WorkerBindings,
    { ...env, ENVIRONMENT: "production" as const },
  ]) {
    const response = await handleParallelPreview(request(`Bearer ${secret}`), bindings, context, delegate);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  }
  assert.equal(calls, 0);
});

test("valid bearer delegates once without forwarding its header", async () => {
  let calls = 0;
  const input = new Request("https://preview.vapt.test/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: "session=synthetic",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "delivered@resend.dev" }),
  });
  const response = await handleParallelPreview(input, env, context, async (forwarded) => {
    calls += 1;
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.url, input.url);
    assert.equal(forwarded.headers.get("authorization"), null);
    assert.equal(forwarded.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(await forwarded.json(), { email: "delivered@resend.dev" });
    return Response.json({ ok: true });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 1);
});

test("an API exception is sanitized without leaking the bearer", async () => {
  const response = await handleParallelPreview(request(`Bearer ${secret}`), env, context, async () => {
    throw new Error(`provider failure ${secret}`);
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.clone().text()).includes(secret), false);
  assert.deepEqual(await response.json(), {
    error: { code: "service_unavailable", message: "Service unavailable" },
  });
});

test("Stripe Test webhook reaches signature verification without an operator bearer", async () => {
  const raw = '{\n  "id": "evt_preview_signed_delivery"\n}';
  const input = new Request("https://preview.vapt.test/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "synthetic-invalid-signature" },
    body: raw,
  });
  let calls = 0;
  const response = await handleParallelPreview(input, { ...env, STRIPE_ENVIRONMENT: "test" }, context, async (forwarded) => {
    calls += 1;
    assert.equal(forwarded.url, input.url);
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.headers.get("stripe-signature"), "synthetic-invalid-signature");
    assert.equal(forwarded.headers.get("authorization"), null);
    assert.equal(await forwarded.text(), raw);
    return Response.json({ error: { code: "invalid_webhook_signature" } }, { status: 401 });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: "invalid_webhook_signature" } });
});

test("Stripe signature headers never bypass the operator bearer on other paths or methods", async () => {
  let calls = 0;
  for (const [method, path] of [
    ["GET", "/webhooks/stripe"],
    ["OPTIONS", "/webhooks/stripe"],
    ["POST", "/webhooks/stripe/"],
    ["POST", "/webhooks/stripe/extra"],
    ["POST", "/webhooks/mercado-pago"],
    ["POST", "/billing/stripe/checkout"],
    ["POST", "/api/auth/sign-in/email"],
  ]) {
    const response = await handleParallelPreview(new Request(`https://preview.vapt.test${path}`, {
      method, headers: { "stripe-signature": "synthetic-invalid-signature" },
    }), { ...env, STRIPE_ENVIRONMENT: "test" }, context, async () => {
      calls += 1;
      return new Response();
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.equal(calls, 0);
});

test("public Stripe webhook admission requires Test mode and a configured preview", async () => {
  let calls = 0;
  for (const bindings of [
    { ...env, STRIPE_ENVIRONMENT: "live" },
    { ...env },
    { ...env, ENVIRONMENT: "production" as const, STRIPE_ENVIRONMENT: "test" },
    { ENVIRONMENT: "preview" as const, STRIPE_ENVIRONMENT: "test" },
  ]) {
    const response = await handleParallelPreview(new Request("https://preview.vapt.test/webhooks/stripe", {
      method: "POST",
    }), bindings, context, async () => { calls += 1; return new Response(); });
    assert.equal(response.status, bindings.ENVIRONMENT === "production" || !bindings.PARALLEL_PREVIEW_TOKEN ? 503 : 401);
  }
  assert.equal(calls, 0);
});

test("public preview webhook verifies signatures and deduplicates through the canonical handler", async () => {
  const { default: Stripe } = await import("stripe");
  const { default: fixture } = await import("./test-fixture.js");
  const bindings: WorkerBindings = { ...env, STRIPE_ENVIRONMENT: "test" };
  const delegate = (input: Request) => Promise.resolve(fixture.fetch(input, bindings, context));
  const raw = JSON.stringify({
    id: "evt_preview_wrapper_signed_delivery", type: "customer.created", created: 1790500000,
    livemode: false, data: { object: { id: "cus_preview_synthetic", object: "customer" } },
  }, null, 2);
  const stripe = new Stripe("sk_test_synthetic", { apiVersion: "2026-08-26.dahlia" });
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload: raw, secret: "whsec_synthetic", cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  for (const [body, header] of [[raw, undefined], [raw, "invalid"], [raw + " ", signature]]) {
    const headers = new Headers({ "content-type": "application/json" });
    if (header) headers.set("stripe-signature", header);
    const response = await handleParallelPreview(new Request("https://preview.vapt.test/webhooks/stripe", {
      method: "POST", headers, body,
    }), bindings, context, delegate);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_webhook_signature");
  }
  for (const duplicate of [false, true]) {
    const response = await handleParallelPreview(new Request("https://preview.vapt.test/webhooks/stripe", {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: raw,
    }), bindings, context, delegate);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      received: true, duplicate, ignored: true, providerEventId: "evt_preview_wrapper_signed_delivery",
    });
  }
  const counts = await fixture.fetch(new Request("https://preview.vapt.test/_test/stripe-counts"), bindings, context);
  assert.deepEqual(await counts.json(), { stripeWebhookCalls: 2, stripeSideEffects: 1 });
});
