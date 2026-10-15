import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("native Worker serves health and encoded parameters in workerd", async () => {
  const server = createTestHarness({
    workers: [
      { configPath: "./wrangler.worker-test.jsonc" },
      { configPath: "./wrangler.worker.jsonc" },
    ],
  });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const health = await fixture.fetch("https://api.vapt.test/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const echo = await fixture.fetch("https://api.vapt.test/_test/echo/hello%20world?q=a%2Bb");
    assert.equal(echo.status, 200);
    assert.deepEqual(await echo.json(), {
      value: "hello world",
      query: "a+b",
      greeting: "synthetic",
    });

    const production = await server.getWorker("vapt-api-preview").fetch("https://api.vapt.test/health");
    assert.equal(production.status, 503);
    assert.deepEqual(await production.json(), {
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  } finally {
    await server.close();
  }
});
