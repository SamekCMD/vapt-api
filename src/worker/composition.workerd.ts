import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("shared composition serves readiness without a payment timer in workerd", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const health = await fixture.fetch("https://api.vapt.test/health");
    assert.equal(health.status, 200);
    const afterHealth = await fixture.fetch("https://api.vapt.test/_test/composition-counts");
    assert.deepEqual(await afterHealth.json(), { serviceFactoryCalls: 0 });

    const ready = await fixture.fetch("https://api.vapt.test/health/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: "ready",
      paymentEffects: { pending: null, lastRunAt: null, lastError: null },
    });
    const afterReady = await fixture.fetch("https://api.vapt.test/_test/composition-counts");
    assert.deepEqual(await afterReady.json(), { serviceFactoryCalls: 1 });
  } finally {
    await server.close();
  }
});
