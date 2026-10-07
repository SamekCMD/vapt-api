import assert from "node:assert/strict";
import test from "node:test";
import { probeWorkerAuthRateLimit } from "./auth-rate-limit-test-support.js";
import { createWorkerAuthRuntimeFactory } from "./auth-runtime.js";
import { syntheticAuthConfig, syntheticSchemaAuthDependencies } from "./auth-context-test-support.js";

for (const [environment, ip, otherIp] of [["preview", "203.0.113.31", "203.0.113.32"], ["production", "203.0.113.33", "203.0.113.34"]]) {
  test(`default Worker ${environment} auth limiter trusts only CF IP, normalizes aliases and preserves CAPTCHA`, async () => {
    const result = await probeWorkerAuthRateLimit(environment, ip, otherIp);
    assert.deepEqual(result.statuses, [400, 400, 400, 429]);
    assert.deepEqual(result.codes.slice(0, 3), ["MISSING_RESPONSE", "MISSING_RESPONSE", "MISSING_RESPONSE"]);
    assert.equal(result.spoofed, 429);
    assert.equal(result.alias, 429);
    assert.ok(result.retryAfter > 0 && result.retryAfter <= 60);
    assert.equal(result.independent, 400);
    assert.equal(result.reset, 400);
    assert.equal(result.signIn, 400);
    assert.equal(result.cookieCount, 0);
    assert.equal(result.tasks, 0);
    assert.deepEqual(result.events, ["rate:connect", "rate:search-path", "rate:schema", "rate:release"]);
  });
}

test("default Worker limiter atomically admits only three concurrent resend attempts per isolate", async () => {
  const events: string[] = [];
  const dep = syntheticSchemaAuthDependencies("concurrent-rate", events);
  const runtime = createWorkerAuthRuntimeFactory()(syntheticAuthConfig(), dep, "production");
  const responses = await Promise.all(Array.from({ length: 4 }, (_, i) => runtime.handler(new Request("https://api.vapt.test/api/auth/send-verification-email", {
    method: "POST", headers: { origin: "https://app.vapt.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.35", "x-forwarded-for": `192.0.2.${i + 10}` },
    body: '{"email":"unknown@vapt.test"}',
  }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [400, 400, 400, 429]);
  assert.equal(dep.tasks.length, 0);
  assert.equal(events.filter(event => event.endsWith(":schema")).length, 1);
  assert.ok(!events.some(event => /:(verification|reset|session|end)$/.test(event)));
  await runtime.close();
});
