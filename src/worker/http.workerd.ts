import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("Worker auth body admission rejects excess before composition and preserves valid payload", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const before = await (await fixture.fetch(`${base}/_test/composition-counts`)).json() as { serviceFactoryCalls: number };
    const denied = await fixture.fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: "é".repeat(524_289),
    });
    assert.equal(denied.status, 413);
    assert.deepEqual(await denied.json(), { error: { code: "payload_too_large", message: "Payload too large" } });
    const after = await (await fixture.fetch(`${base}/_test/composition-counts`)).json() as { serviceFactoryCalls: number };
    assert.equal(after.serviceFactoryCalls, before.serviceFactoryCalls);
    const body = '{"email":"synthetic@example.invalid","name":"José"}';
    const accepted = await fixture.fetch(`${base}/api/auth/sign-in/email?keep=query`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.vapt.test" }, body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { method: "POST", search: "?keep=query", body });
    assert.equal(accepted.headers.get("access-control-allow-origin"), "https://app.vapt.test");
    assert.equal(accepted.headers.getSetCookie().length, 2);
  } finally { await server.close(); }
});

test("Worker HTTP policy preserves safe errors, CORS and fail-closed ingress limits", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const preflight = await fixture.fetch(`${base}/_test/protected`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.vapt.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type,x-captcha-response",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.vapt.test");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Captcha-Response/i);
    const head = await fixture.fetch(`${base}/health`, {
      method: "HEAD", headers: { origin: "https://app.vapt.test" },
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("access-control-allow-credentials"), "true");

    const unknown = await fixture.fetch(`${base}/missing`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: { code: "not_found", message: "Route not found" } });

    const malformed = await fixture.fetch(`${base}/_test/parse`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"secret":"never-log",',
    });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.stringify(await malformed.json()).includes("never-log"), false);

    const validOrder = JSON.stringify({ restaurantSlug: "synthetic-restaurant", channel: "local",
      tableNumber: 1, items: [{ menuItemId: "10000000-0000-4000-8000-000000000013", quantity: 1 }] });
    const wrongType = await fixture.fetch(`${base}/public/orders`, {
      method: "POST", headers: { "content-type": "text/plain", "idempotency-key": "synthetic-body-type" },
      body: validOrder,
    });
    assert.equal(wrongType.status, 400);
    const missingType = await fixture.fetch(`${base}/public/orders`, {
      method: "POST", headers: { "idempotency-key": "synthetic-missing-type" },
      body: new TextEncoder().encode(validOrder),
    });
    assert.equal(missingType.status, 500);
    const oversized = await fixture.fetch(`${base}/public/orders`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "synthetic-oversized" },
      body: JSON.stringify({ filler: "x".repeat(1_048_576) }),
    });
    assert.equal(oversized.status, 500);

    const missingIp = await fixture.fetch(`${base}/_test/missing-ingress`);
    assert.equal(missingIp.status, 429);
    const malformedIp = await fixture.fetch(`${base}/_test/protected`, {
      headers: { "cf-connecting-ip": "not-an-ip" },
    });
    assert.equal(malformedIp.status, 429);
    const missingLimiter = await fixture.fetch(`${base}/_test/protected`, { headers: { "cf-connecting-ip": "203.0.113.1" } });
    assert.equal(missingLimiter.status, 503);

    const disallowed = await fixture.fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(disallowed.status, 500);
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.close();
  }
});
