import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("workerd auth bridge isolates concurrent SQL transactions and email runners and rejects expired scopes", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-auth-context.jsonc" }] });
  try {
    await server.listen();
    const response = await server.getWorker("vapt-api-auth-context-test").fetch("https://auth-context.vapt.test/");
    assert.equal(response.status, 200);
    const body = await response.json() as { results: string[]; events: string[]; missing: boolean; expired: boolean; taskCounts: number[] };
    assert.deepEqual(body.results, ["a", "b"]);
    assert.equal(body.missing, true);
    assert.equal(body.expired, true);
    assert.deepEqual(body.taskCounts, [1, 1]);
    for (const owner of ["a", "b"]) {
      assert.deepEqual(body.events.filter(event => event.startsWith(`${owner}:`)), [`${owner}:connect`, `${owner}:begin`, `${owner}:select owner`, `${owner}:commit`, `${owner}:release`, `${owner}:reset`]);
    }
  } finally { await server.close(); }
});
