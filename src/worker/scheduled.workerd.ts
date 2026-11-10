import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("scheduled Worker performs one bounded reconciliation pass without an interval", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-misc.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-misc-test");
    const result = await fixture.scheduled({ cron: "0 * * * *", scheduledTime: new Date() });
    assert.equal(result.outcome, "ok");
    const counts = await fixture.fetch("https://api.vapt.test/_test/misc-counts");
    const countsBody = await counts.json() as { adminRunCalls: number; adminRequestedLimit: number; intervalStarts: number };
    assert.equal(countsBody.adminRunCalls, 1);
    assert.ok(countsBody.adminRequestedLimit <= 25);
    assert.equal(countsBody.intervalStarts, 0);
  } finally {
    await server.close();
  }
});

test("scheduled reconciliation failures remain visible for retry", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-scheduled-fail.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-scheduled-fail-test");
    const result = await fixture.scheduled({ cron: "0 * * * *", scheduledTime: new Date() });
    assert.notEqual(result.outcome, "ok");
    assert.equal(result.noRetry, false);
  } finally {
    await server.close();
  }
});
