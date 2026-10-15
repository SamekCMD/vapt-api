import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";
import WebSocket from "ws";

test("local browser fixture isolates two synthetic owners and publishes persisted status changes", { timeout: 60_000 }, async () => {
  const harness = createTestHarness({ workers: [{ configPath: "./wrangler.worker-realtime-test.jsonc" }] });
  const sockets: WebSocket[] = [];
  try {
    const { url } = await harness.listen();
    const worker = harness.getWorker("vapt-realtime-test");
    const request = (path: string, cookie = "", body?: unknown) => worker.fetch(`http://localhost/browser/v1/${path}`, {
      method: body ? "POST" : "GET", headers: { cookie, origin: "http://127.0.0.1:5179", "cf-connecting-ip": "127.0.0.1",
        ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "99999999-9999-4999-8999-999999999999";
    const login = await request("test/login/a");
    assert.equal(login.headers.get("content-type")?.includes("text/html"), true);
    assert.match(login.headers.get("set-cookie") ?? "", /local-owner=a; HttpOnly/);
    assert.equal((await request("restaurants/me")).status, 401);
    assert.equal((await request("restaurants/me", "local-owner=a")).status, 200);
    assert.equal((await (await request("restaurants/me", "local-owner=b")).json() as any).id, b);
    assert.equal((await request("realtime/tickets", "local-owner=b", { mode: "owner", restaurantId: a })).status, 403);
    const connect = async (rest: string, cookie: string) => {
      const response = await request("realtime/tickets", cookie, { mode: "owner", restaurantId: rest });
      assert.equal(response.status, 200);
      const ticket = await response.json() as any;
      const wsUrl = new URL(`/browser/v1/realtime/restaurants/${rest}/socket`, url); wsUrl.protocol = "ws:";
      const socket = new WebSocket(wsUrl, ["vapt.realtime.v1", `vapt.ticket.${ticket.ticket}`], { origin: "http://127.0.0.1:5179", closeTimeout: 1000 } as WebSocket.ClientOptions);
      sockets.push(socket); const frames: any[] = [];
      socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await waitFor(() => frames.length === 1); return frames;
    };
    const framesA = await connect(a, "local-owner=a");
    const framesB = await connect(b, "local-owner=b");
    const created = await request("test/orders/a", "", { status: "pending" });
    assert.equal(created.status, 201);
    const order = await created.json() as any;
    await waitFor(() => framesA.length >= 3);
    assert.equal(framesB.length, 1);
    assert.equal((await (await request("restaurants/me/kitchen/orders", "local-owner=a")).json() as any[]).length, 1);
    assert.equal((await (await request("restaurants/me/kitchen/orders", "local-owner=b")).json() as any[]).length, 0);
    assert.equal((await request(`restaurants/me/kitchen/orders/${order.orderId}/status`, "local-owner=b", { status: "ready" })).status, 404);
    const changed = await worker.fetch(`http://localhost/browser/v1/restaurants/me/kitchen/orders/${order.orderId}/status`, {
      method: "PATCH", headers: { cookie: "local-owner=a", "content-type": "application/json" }, body: JSON.stringify({ status: "ready" }),
    });
    assert.equal(changed.status, 200); assert.equal((await changed.json() as any).status, "ready");
    const sessions = await (await request("restaurants/me/table-sessions", "local-owner=a")).json() as any[];
    assert.equal(sessions[0].orderCount, 1); assert.equal(sessions[0].sessionTotal, "23.50");
    assert.equal((await request(`public/orders/${order.orderId}`)).status, 404);
    const publicCreate = await request("public/orders", "", { restaurantSlug: "synthetic-a", channel: "local", tableNumber: 1,
      items: [{ menuItemId: "10000000-0000-4000-8000-000000000001", quantity: 1 }] });
    assert.equal(publicCreate.status, 201);
    const publicOrder = await publicCreate.json() as any;
    assert.equal(publicOrder.publicToken, "synthetic-public-token-a");
    const publicRead = await worker.fetch(`http://localhost/browser/v1/public/orders/${publicOrder.orderId}`, {
      headers: { "x-vapt-order-token": "synthetic-public-token-a" },
    });
    assert.equal(publicRead.status, 200);
    assert.equal((await publicRead.json() as any).orderId, publicOrder.orderId);
    const cleared = await request("test/control/a", "", { clear: true });
    assert.deepEqual(await cleared.json(), { orders: 0 });
    assert.deepEqual(await (await request("restaurants/me/kitchen/orders", "local-owner=a")).json(), []);
  } finally { sockets.forEach(socket => socket.terminate()); await harness.close(); }
});
async function waitFor(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw new Error("Local fixture condition not reached"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
