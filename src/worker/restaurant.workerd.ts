import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

const uuid = "10000000-0000-4000-8000-000000000021";
const base = "https://api.vapt.test";

test("private Worker route inventory requires a session and scopes owner operations", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const routes = [
      ["POST", "/onboarding"], ["GET", "/restaurants/me"], ["PATCH", "/restaurants/me"],
      ["GET", "/restaurants/me/menu-items"], ["POST", "/restaurants/me/menu-items"],
      ["PATCH", `/restaurants/me/menu-items/${uuid}`], ["DELETE", `/restaurants/me/menu-items/${uuid}`],
      ["GET", "/restaurants/me/kitchen/orders"],
      ["PATCH", `/restaurants/me/kitchen/orders/${uuid}/status`],
      ["GET", "/restaurants/me/overview"],
      ["GET", "/restaurants/me/table-sessions"],
      ["GET", `/restaurants/me/table-sessions/${uuid}`],
      ["POST", `/restaurants/me/table-sessions/${uuid}/close`],
      ["POST", `/restaurants/me/table-sessions/${uuid}/transfer`],
    ] as const;
    for (const [method, path] of routes) {
      const response = await fixture.fetch(`${base}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
    }

    const ownedMenu = await fixture.fetch(`${base}/restaurants/me/menu-items`, {
      headers: { cookie: "session=owner" },
    });
    assert.equal(ownedMenu.status, 200);
    assert.deepEqual(await ownedMenu.json(), []);
    const deleted = await fixture.fetch(`${base}/restaurants/me/menu-items/${uuid}`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(deleted.status, 204);
    const foreign = await fixture.fetch(`${base}/restaurants/me/menu-items/10000000-0000-4000-8000-000000000022`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(foreign.status, 404);
    const malformed = await fixture.fetch(`${base}/restaurants/me/menu-items/not-a-uuid`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.close();
  }
});
