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
      ['GET','/restaurants/10000000-0000-4000-8000-000000000001'],
      ['GET','/restaurants/10000000-0000-4000-8000-000000000001/slug-availability?slug=novo-slug'],
      ['PATCH','/restaurants/10000000-0000-4000-8000-000000000001'],
      ['GET','/restaurants/10000000-0000-4000-8000-000000000001/menu-items'],
      ['POST','/restaurants/10000000-0000-4000-8000-000000000001/menu-items'],
      ['PATCH',`/restaurants/10000000-0000-4000-8000-000000000001/menu-items/${uuid}`],
      ['DELETE',`/restaurants/10000000-0000-4000-8000-000000000001/menu-items/${uuid}`],
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

    const explicit='/restaurants/10000000-0000-4000-8000-000000000001';
    const headers={ cookie:'session=owner','content-type':'application/json' };
    const availability=await fixture.fetch(base+explicit+'/slug-availability?slug=novo-slug',{headers});
    assert.equal(availability.status,200);assert.equal(availability.headers.get('Cache-Control'),'no-store');assert.deepEqual(await availability.json(),{available:true});
    assert.equal((await fixture.fetch(base+explicit+'/slug-availability?slug=-invalido',{headers})).status,400);
    assert.equal((await fixture.fetch(base+'/restaurants/10000000-0000-4000-8000-000000000002/slug-availability?slug=novo-slug',{headers})).status,403);
    const scopedRead=await fixture.fetch(base+explicit,{ headers });
    assert.equal(scopedRead.status,200);
    assert.equal((await scopedRead.json() as { id:string }).id,'10000000-0000-4000-8000-000000000001');
    const scopedPatch=await fixture.fetch(base+explicit,{ method:'PATCH',headers,body:JSON.stringify({ name:'Nome scoped' }) });
    assert.equal(scopedPatch.status,200);
    assert.equal((await scopedPatch.json() as { name:string }).name,'Nome scoped');
    assert.equal((await fixture.fetch(base+explicit+'/menu-items',{ headers })).status,200);
    assert.equal((await fixture.fetch(base+explicit+'/menu-items/'+uuid,{ method:'DELETE',headers })).status,204);
    assert.equal((await fixture.fetch(base+'/restaurants/10000000-0000-4000-8000-000000000002',{ headers })).status,403);
    assert.equal((await fixture.fetch(base+'/restaurants/10000000-0000-4000-8000-000000000002/menu-items',{ headers })).status,403);
    assert.equal((await fixture.fetch(base+explicit+'/menu-items/10000000-0000-4000-8000-000000000022',{ method:'DELETE',headers })).status,404);
    assert.equal((await fixture.fetch(base+explicit,{ method:'PATCH',headers,body:JSON.stringify({ name:'Forjado',ownerId:uuid }) })).status,400);
  } finally {
    await server.close();
  }
});
