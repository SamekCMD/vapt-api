import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";
import type { probeWorkerAuthRateLimit } from "./auth-rate-limit-test-support.js";

test("workerd real default auth limiter remains enabled without production NODE_ENV and ignores forwarded spoofing", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-auth-rate-limit.jsonc" }] });
  try {
    await server.listen();
    const response = await server.getWorker("vapt-api-auth-rate-limit-test").fetch("https://auth-rate.vapt.test/");
    assert.equal(response.status, 200);
    const body = await response.json() as { nodeEnvProduction: boolean; preview: Awaited<ReturnType<typeof probeWorkerAuthRateLimit>>; production: Awaited<ReturnType<typeof probeWorkerAuthRateLimit>> };
    assert.equal(body.nodeEnvProduction, false);
    for (const result of [body.preview, body.production]) {
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
      assert.equal(result.events.filter(event => event.endsWith(":schema")).length, 1);
      assert.ok(!result.events.some(event => /:(verification|reset|session|end)$/.test(event)));
    }
  } finally { await server.close(); }
});
