import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("production entrypoint serves health and applies a native rate-limit binding", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-production-entry.jsonc" }] });
  try {
    await server.listen();
    const worker = server.getWorker("vapt-api-worker-production-entry-test");
    const base = "https://api.vapt.test";
    const health = await worker.fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const headers = { "cf-connecting-ip": "203.0.113.81" };
    const first = await worker.fetch(`${base}/auth/me`, { headers });
    assert.notEqual(first.status, 429);
    const denied = await worker.fetch(`${base}/auth/me`, { headers });
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), {
      error: { code: "rate_limit_exceeded", message: "Too many requests" },
    });
  } finally {
    await server.close();
  }
});
