import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

import { ROUTE_CONTRACTS, WORKER_ONLY_ROUTE_CONTRACTS } from "./route-contract.js";

test("all Fastify route contracts have a native Worker method and path", async () => {
  const server = createTestHarness({ workers: [
    { configPath: "./wrangler.worker-test-all.jsonc" },
    { configPath: "./wrangler.worker-test.jsonc" },
    { configPath: "./wrangler.worker.jsonc" },
  ] });
  try {
    await server.listen();
    const base = "https://api.vapt.test";
    const enabled = server.getWorker("vapt-api-worker-all-test");
    const inventory = await enabled.fetch(`${base}/_test/route-inventory`);
    assert.equal(inventory.status, 200);
    const actual = await inventory.json() as Array<{ method: string; path: string }>;
    const expected = [...ROUTE_CONTRACTS, ...WORKER_ONLY_ROUTE_CONTRACTS].map(({ method, path }) => ({ method, path }));
    const sorted = (routes: Array<{ method: string; path: string }>) => routes.sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
    assert.deepEqual(sorted(actual), sorted(expected));

    const disabled = server.getWorker("vapt-api-worker-test");
    assert.equal((await disabled.fetch(`${base}/payments/mercado-pago/oauth/callback`)).status, 404);
    assert.equal((await disabled.fetch(`${base}/restaurants/10000000-0000-4000-8000-000000000001/menu-items/10000000-0000-4000-8000-000000000041/image`, {
      method: "DELETE",
    })).status, 404);
    const production = server.getWorker("vapt-api-preview");
    const unavailable = await production.fetch(`${base}/health`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  } finally {
    await server.close();
  }
});
