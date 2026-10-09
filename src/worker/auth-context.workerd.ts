import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("workerd auth bridge isolates concurrent SQL transactions and email runners and rejects expired scopes", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test-auth-context.jsonc" }] });
  try {
    await server.listen();
    const response = await server.getWorker("vapt-api-auth-context-test").fetch("https://auth-context.vapt.test/");
    assert.equal(response.status, 200);
    const body = await response.json() as { results: string[]; events: string[]; missing: boolean; expired: boolean; taskCounts: number[]; sessions: unknown[]; authEvents: string[]; badSchema: boolean; concurrentEvents: string[]; concurrentSessions: unknown[] };
    assert.deepEqual(body.results, ["a", "b"]);
    assert.equal(body.missing, true);
    assert.equal(body.expired, true);
    assert.deepEqual(body.taskCounts, [1, 1]);
    for (const owner of ["a", "b"]) {
      assert.deepEqual(body.events.filter(event => event.startsWith(`${owner}:`)), [`${owner}:connect`, `${owner}:begin`, `${owner}:select owner`, `${owner}:commit`, `${owner}:release`, `${owner}:reset`]);
    }
    assert.deepEqual(body.sessions, [null, null, null]);
    assert.equal(body.badSchema, true);
    assert.deepEqual(body.authEvents.filter(x => x.endsWith(":schema")), ["a:schema"]);
    assert.ok(body.authEvents.includes("c:session"));
    assert.ok(!body.authEvents.includes("a:session") && !body.authEvents.includes("b:session"));
    assert.deepEqual(body.concurrentSessions, [null, null]);
    assert.equal(body.concurrentEvents.filter(x => x.endsWith(":schema")).length, 1);
    for (const owner of ["p", "q"]) assert.ok(body.concurrentEvents.includes(`${owner}:session`));
  } finally { await server.close(); }
});
