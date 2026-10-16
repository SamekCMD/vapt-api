import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";
import WebSocket from "ws";
import type { CatalogState } from "../modules/catalog-publication/contracts.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const origin = "https://app.vapt.test";
function state(version: string, id = restaurantId): CatalogState {
  return { version, catalog: { restaurant: { id, name: "Bistrô", slug: id === restaurantId ? "bistro" : "capacity",
    whatsapp: null, address: null, phone: null, hours: null, description: null, primaryColor: "#123456", secondaryColor: "#654321", fontFamily: "modern", logoUrl: null,
    totalTables: 1, maxTables: 1, paymentMode: "open_tab", maxPendingOrders: 3, localEnabled: true, deliveryEnabled: true, updatedAt: "2026-10-15T00:00:00Z" }, items: [] } };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, "expected WebSocket event before timeout");
}
test("public catalog actual101, static heartbeat, hibernation and write rejection without SQL", { timeout: 90_000 }, async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-catalog-test.jsonc" }] });
  const sockets: WebSocket[] = [];
  try {
    const { url } = await server.listen(); const worker = server.getWorker("vapt-catalog-test");
    const publish = async (version: string, id = restaurantId) => {
      const response = await worker.fetch("https://api.test/_test/publish", { method: "POST", body: JSON.stringify(state(version, id)) });
      assert.equal(response.status, 200, await response.clone().text());
    };
    const info = async (): Promise<any> => (await worker.fetch(`https://api.test/_test/info/${restaurantId}`)).json();
    const connect = async () => {
      const endpoint = new URL(`/v1/catalog/restaurants/${restaurantId}/socket`, url); endpoint.protocol = "ws:";
      const socket = new WebSocket(endpoint, ["vapt.catalog.v1"], { origin, closeTimeout: 1000 } as WebSocket.ClientOptions);
      sockets.push(socket); const frames: string[] = []; let status: number | undefined; let closed: number | undefined; let error: Error | undefined;
      socket.on("upgrade", response => { status = response.statusCode; assert.equal(response.headers["sec-websocket-protocol"], "vapt.catalog.v1"); });
      socket.on("message", data => frames.push(data.toString())); socket.on("close", code => { closed = code; }); socket.on("error", value => { error = value; });
      await waitFor(() => frames.length > 0 || !!error); if (error) throw error;
      assert.equal(status, 101); assert.deepEqual(JSON.parse(frames[0]!), { protocol: "vapt.catalog.v1", type: "ready", version: "12", canonicalSlug: "bistro" });
      return { socket, frames, closed: () => closed };
    };
    await publish("11"); await publish("12");
    for (const path of ["/public/restaurants/bistro/catalog", "/public/restaurants/bistro/catalog-state"]) {
      const response = await worker.fetch(`https://api.test${path}`); assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    const a = await connect(); const before = await info();
    a.socket.send("vapt.catalog.v1:ping"); await waitFor(() => a.frames.length === 2);
    assert.equal(a.frames[1], "vapt.catalog.v1:pong"); assert.equal((await info()).messages, 0, "heartbeat bypasses JavaScript handler");
    await worker.evictDurableObject("PUBLIC_CATALOG_COORDINATOR", { name: `preview:${restaurantId}`, webSockets: "hibernate" });
    a.socket.send("vapt.catalog.v1:ping"); await waitFor(() => a.frames.length === 3);
    assert.equal(a.frames[2], "vapt.catalog.v1:pong");
    await publish("9007199254740993"); await waitFor(() => a.frames.length === 4);
    assert.deepEqual(JSON.parse(a.frames[3]!), { protocol: "vapt.catalog.v1", type: "catalog_changed", version: "9007199254740993", canonicalSlug: "bistro" });
    const after = await info(); assert.ok(after.constructors > before.constructors); assert.equal(after.messages, 0); assert.equal(after.alarm, null);
    assert.deepEqual(after.attachments, [{ protocol: "vapt.catalog.v1", restaurantId, environment: "preview", lastSentVersion: "9007199254740993" }]);
    assert.equal((await worker.fetch(`https://api.test/_test/anonymous-command/${restaurantId}`)).status, 404);
    a.socket.send('{"type":"submit","mutation":{"type":"rebuild"}}'); await waitFor(() => a.closed() !== undefined); assert.equal(a.closed(), 1008);
    // Separate connections avoid mistaking a prior policy close for frame-limit enforcement.
    const connectLatest = async () => {
      const endpoint = new URL(`/v1/catalog/restaurants/${restaurantId}/socket`, url); endpoint.protocol = "ws:";
      const socket = new WebSocket(endpoint, { origin, closeTimeout: 1000 } as WebSocket.ClientOptions); sockets.push(socket);
      let ready = false; let closed: number | undefined;
      socket.on("message", () => { ready = true; }); socket.on("close", code => { closed = code; });
      await waitFor(() => ready); return { socket, closed: () => closed };
    };
    const oversized = await connectLatest(); oversized.socket.send("é".repeat(257)); await waitFor(() => oversized.closed() !== undefined); assert.equal(oversized.closed(), 1009);
    const binary = await connectLatest(); binary.socket.send(Buffer.from([1])); await waitFor(() => binary.closed() !== undefined); assert.equal(binary.closed(), 1003);
    const services = await (await worker.fetch("https://api.test/_test/services")).json();
    assert.deepEqual(services, { calls: 0, hyperdrivePresent: false }, "no auth/database composition, and no SQL binding available");
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
  }
});
