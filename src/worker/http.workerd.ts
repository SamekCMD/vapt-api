import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

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

    const missingIp = await fixture.fetch(`${base}/_test/missing-ingress`);
    assert.equal(missingIp.status, 429);
    const missingLimiter = await fixture.fetch(`${base}/_test/protected`, { headers: { "cf-connecting-ip": "203.0.113.1" } });
    assert.equal(missingLimiter.status, 503);

    const disallowed = await fixture.fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(disallowed.status, 500);
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.close();
  }
});
