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
    const initialStorage = await (await worker.fetch("https://api.test/_test/storage-audit")).json() as { imageKeys: string[]; catalogKeys: string[] };
    assert.deepEqual(initialStorage.imageKeys, [], "publication never writes into image storage");
    assert.ok(initialStorage.catalogKeys.some(key => key.endsWith("/snapshots/12.json")));
    assert.equal((await worker.fetch("https://api.test/_test/image-catalog-decoy", { method: "POST", body: JSON.stringify(state("99")) })).status, 200);
    for (const path of ["/public/restaurants/bistro/catalog", "/public/restaurants/bistro/catalog-state"]) {
      const response = await worker.fetch(`https://api.test${path}`); assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      if (path.endsWith("catalog-state")) assert.equal((await response.json() as CatalogState).version, "12", "public image bucket decoy must not win");
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
    const storageAfter = await (await worker.fetch("https://api.test/_test/storage-audit")).json() as { imageKeys: string[]; catalogKeys: string[] };
    assert.ok(storageAfter.imageKeys.every(key => !key.endsWith("/snapshots/9007199254740993.json")), "published signal revision stays out of images");
    assert.ok(storageAfter.catalogKeys.some(key => key.endsWith("/snapshots/9007199254740993.json")));
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

for (const [fault, phase] of [["accepted", "accepted"], ["committed", "accepted"], ["projection", "committed"], ["signal", "ready"]] as const) {
  test(`crashRestartConverges on actual SQLite/alarm at ${fault}; reader rollback drains accepted writer`, { timeout: 90_000 }, async () => {
    const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-catalog-test.jsonc" }] });
    try {
      await server.listen(); const worker = server.getWorker("vapt-catalog-test");
      const call = async (action: string, body = {}) => {
        const response = await worker.fetch(`https://api.test/_test/execution/${action}`, { method: "POST", body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<any>;
      };
      const command = { operationId: "33333333-3333-4333-8333-333333333333", restaurantId,
        actor: { userId: "22222222-2222-4222-8222-222222222222", sessionId: "44444444-4444-4444-8444-444444444444", sessionExpiresAt: 1_800_001_000_000 }, mutation: { type: "rebuild" } };
      const first = await call("begin", { command, state: state("11"), fault });
      assert.equal(first.receipt.phase, phase); assert.notEqual(first.alarm, null, "accepted recovery schedule is durable");
      await worker.evictDurableObject("CATALOG_EXECUTION_PROBE", { name: "execution", webSockets: "hibernate" });
      const done = await call("retry", { readerEnabled: false });
      assert.equal(done.receipt.phase, "ready"); assert.equal(done.writes, 1, "simulated external journal applied only once");
      assert.ok(done.constructors >= 2); assert.equal(done.privateChunks, false);
      const response = await worker.fetch("https://api.test/public/restaurants/bistro/catalog-state");
      assert.equal(response.status, 200); assert.equal((await response.json() as CatalogState).version, "11");
      const before = done.writes; const idle = await call("idle"); assert.equal(idle.writes, before, "idle alarm does not query simulated PostgreSQL");
      assert.equal(idle.lookups, done.lookups); assert.equal(idle.applies, done.applies);
    } finally { await server.close(); }
  });
}

test("maxPayloadBounded at 8MiB snapshot and 1MiB optimized image on actual workerd", { timeout: 90_000 }, async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-catalog-test.jsonc" }] });
  try {
    await server.listen(); const worker = server.getWorker("vapt-catalog-test");
    const oversizedImage = await worker.fetch("https://api.test/_test/image-budget", { method: "POST", body: JSON.stringify({ bytes: 1_048_577 }) });
    assert.equal(oversizedImage.status, 400);
    const image = await worker.fetch("https://api.test/_test/image-budget", { method: "POST", body: JSON.stringify({ bytes: 1_048_576 }) });
    assert.equal(image.status, 200);
    const value = state("11"); value.catalog.restaurant.description = "";
    const base = Buffer.byteLength(JSON.stringify(value));
    value.catalog.restaurant.description = "a".repeat(8_388_608 - base);
    assert.equal(Buffer.byteLength(JSON.stringify(value)), 8_388_608);
    const published = await worker.fetch("https://api.test/_test/publish", { method: "POST", body: JSON.stringify(value) });
    assert.equal(published.status, 200);
    const read = await worker.fetch("https://api.test/public/restaurants/bistro/catalog-state"); assert.equal(read.status, 200);
    assert.equal(Buffer.byteLength(await read.text()), 8_388_608);
    value.version = "12"; value.catalog.restaurant.description += "a";
    const rejected = await worker.fetch("https://api.test/_test/publish", { method: "POST", body: JSON.stringify(value) });
    assert.equal(rejected.status, 503);
    const retained = await worker.fetch("https://api.test/public/restaurants/bistro/catalog-state");
    assert.equal((await retained.json() as CatalogState).version, "11", "oversize revision never replaces readable state");
  } finally { await server.close(); }
});

test("actual room caps 200 sockets across hibernation with no SQL/auth service", { timeout: 90_000 }, async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-catalog-test.jsonc" }] });
  const sockets: WebSocket[] = [];
  try {
    const { url } = await server.listen(); const worker = server.getWorker("vapt-catalog-test");
    assert.equal((await worker.fetch("https://api.test/_test/publish", { method: "POST", body: JSON.stringify(state("11")) })).status, 200);
    const endpoint = new URL(`/v1/catalog/restaurants/${restaurantId}/socket`, url); endpoint.protocol = "ws:";
    for (let index = 0; index < 200; index++) {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(endpoint, ["vapt.catalog.v1"], { origin, closeTimeout: 1000 } as WebSocket.ClientOptions); sockets.push(socket);
        socket.once("message", () => resolve()); socket.once("error", reject);
      });
    }
    await worker.evictDurableObject("PUBLIC_CATALOG_COORDINATOR", { name: `preview:${restaurantId}`, webSockets: "hibernate" });
    const refused = await worker.fetch(`https://api.test/v1/catalog/restaurants/${restaurantId}/socket`, { headers: { Origin: origin, Upgrade: "websocket", "Sec-WebSocket-Protocol": "vapt.catalog.v1" } });
    assert.equal(refused.status, 503);
    const info = await (await worker.fetch(`https://api.test/_test/info/${restaurantId}`)).json() as any;
    assert.equal(info.sockets, 200); assert.equal(info.alarm, null);
    assert.deepEqual(await (await worker.fetch("https://api.test/_test/services")).json(), { calls: 0, hyperdrivePresent: false });
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); }
});
