import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

const ownerRestaurant = "10000000-0000-4000-8000-000000000001";
const otherRestaurant = "10000000-0000-4000-8000-000000000002";

test("native auth forwards Fetch requests and protects sessions and ownership", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const get = await fixture.fetch(`${base}/api/auth/inspect?state=a%2Bb`, {
      headers: { origin: "https://app.vapt.test" },
    });
    assert.equal(get.status, 200);
    const cookies = get.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cookie of cookies) {
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
    }
    assert.equal(get.headers.get("access-control-allow-credentials"), "true");
    assert.deepEqual(await get.json(), { method: "GET", search: "?state=a%2Bb", body: null });

    const post = await fixture.fetch(`${base}/api/auth/inspect`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"synthetic":true}',
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { method: "POST", search: "", body: '{"synthetic":true}' });

    const noSession = await fixture.fetch(`${base}/auth/me`);
    assert.equal(noSession.status, 401);
    const bearerOnly = await fixture.fetch(`${base}/auth/me`, { headers: { authorization: "Bearer legacy" } });
    assert.equal(bearerOnly.status, 401);
    const owner = await fixture.fetch(`${base}/auth/me`, { headers: { cookie: "session=owner" } });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { userId: "user-1", email: "owner@vapt.test", role: "authenticated" });

    const allowed = await fixture.fetch(`${base}/auth/restaurants/${ownerRestaurant}/access`, {
      headers: { cookie: "session=owner" },
    });
    assert.equal(allowed.status, 200);
    const forbidden = await fixture.fetch(`${base}/auth/restaurants/${otherRestaurant}/access`, {
      headers: { cookie: "session=owner" },
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await server.close();
  }
});
