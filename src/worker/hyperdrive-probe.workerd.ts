import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("diagnostic entrypoint exposes no production route", async () => {
  const secret = randomBytes(32).toString("hex");
  const server = createTestHarness({ workers: [{
    configPath: "./wrangler.worker-probe-test.jsonc",
    secrets: { PROBE_TOKEN: secret },
  }] });
  try {
    await server.listen();
    const worker = server.getWorker("vapt-api-hyperdrive-probe-test");
    const response = await worker.fetch("https://probe.vapt.test/auth/me", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});
