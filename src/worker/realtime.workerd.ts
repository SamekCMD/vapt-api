import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createTestHarness } from "wrangler";
import WebSocket from "ws";

const restaurant = "11111111-1111-4111-8111-111111111111";
const otherRestaurant = "99999999-9999-4999-8999-999999999999";
const order = "22222222-2222-4222-8222-222222222222";
const otherOrder = "33333333-3333-4333-8333-333333333333";
const origin = "https://app.vapt.test";
const owner = { mode: "owner", restaurantId: restaurant, userId: order, sessionId: otherOrder, sessionExpiresAt: 4_000_000_000_000 };
const guest = { mode: "order", restaurantId: restaurant, orderId: order, tokenFingerprint: "a".repeat(64) };

test("SQLite rooms prove upgrade, tenant/order isolation, limits and real hibernation in workerd", { timeout: 120_000 }, async () => {
  assert.equal(existsSync("./wrangler.worker-realtime-test.jsonc"), true, "realtime workerd fixture exists");
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-realtime-test.jsonc" }] });
  const sockets: any[] = [];
  try {
    const { url: listenUrl } = await server.listen();
    const worker = server.getWorker("vapt-realtime-test");
    const rpc = async (op: string, body: unknown, rest = restaurant): Promise<any> => {
      const response = await worker.fetch(`https://api.vapt.test/${op}/${rest}`, { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const issue = (grant = guest, rest = restaurant) => rpc("issue", { environment: "preview", origin, grant }, rest);
    const connect = async (grant: any = guest, rest = restaurant) => {
      const ticket = await issue(grant, rest);
      const url = new URL(`/socket/${rest}`, listenUrl);
      url.protocol = "ws:";
      // workerd's local proxy may delay TCP EOF after an eviction close exchange.
      // A missing server close still yields 1006, so this preserves policy proof.
      const options: WebSocket.ClientOptions & { closeTimeout: number } = { origin, closeTimeout: 1000 };
      const socket = new WebSocket(url, ["vapt.realtime.v1", `vapt.ticket.${ticket.ticket}`], options);
      socket.on("upgrade", response => {
        assert.equal(response.statusCode, 101);
        assert.equal(response.headers["sec-websocket-protocol"], "vapt.realtime.v1");
      });
      sockets.push(socket);
      const frames: any[] = [];
      let closed: number | undefined;
      socket.on("message", data => frames.push(JSON.parse(data.toString())));
      socket.on("close", code => { closed = code; });
      socket.on("error", error => { throw error; });
      await waitFor(() => frames.length === 1);
      assert.equal(frames[0].type, "ready");
      assert.ok(frames[0].leaseExpiresAt > Date.now());
      return { socket, frames, closed: () => closed, ticket };
    };
    const a = await connect(owner);
    const b = await connect(guest);
    const c = await connect({ ...guest, orderId: otherOrder });
    const d = await connect({ ...guest, restaurantId: otherRestaurant }, otherRestaurant);
    const publish = (ids = [order], rest = restaurant) => rpc("publish", { restaurantId: rest,
      topics: ["orders", "kitchen", "payments"], orderIds: ids, entityId: otherOrder, reason: "payment_changed" }, rest);
    assert.equal((await publish()).delivered, 4);
    await waitFor(() => a.frames.length === 4 && b.frames.length === 2);
    assert.deepEqual(b.frames[1].topic, "orders");
    assert.equal(b.frames[1].entityId, order);
    assert.equal(c.frames.length, 1);
    assert.equal(d.frames.length, 1);
    assert.equal(b.frames.some(frame => frame.entityId === otherOrder), false);
    assert.equal(JSON.stringify(a.frames).includes("tokenFingerprint"), false);
    a.socket.send(JSON.stringify({ version: 1, type: "ack", sequence: 3 }));
    b.socket.send(JSON.stringify({ version: 1, type: "ack", sequence: 1 }));

    const constructorsBefore = (await rpc("info", {})).constructors;
    await worker.evictDurableObject("ROOMS", { name: restaurant, webSockets: "hibernate" });
    assert.equal((await publish([otherOrder])).delivered, 4);
    await waitFor(() => a.frames.length === 7 && c.frames.length === 2);
    assert.ok((await rpc("info", {})).constructors > constructorsBefore, "actual eviction reconstructs object");
    assert.equal(b.frames.length, 2);

    const wrong = await issue();
    for (const [rest, sentOrigin] of [[otherRestaurant, origin], [restaurant, "https://evil.vapt.test"]]) {
      const response = await worker.fetch(`https://api.vapt.test/socket/${rest}`, { headers: {
        Upgrade: "websocket", Origin: sentOrigin, "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${wrong.ticket}`,
      } });
      assert.equal(response.status, 403);
    }
    const reuse = await worker.fetch(`https://api.vapt.test/socket/${restaurant}`, { headers: {
      Upgrade: "websocket", Origin: origin, "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${b.ticket.ticket}`,
    } });
    assert.equal(reuse.status, 403);
    assert.equal((await worker.fetch(`https://api.vapt.test/socket/${restaurant}`, { method: "POST" })).status, 405);

    const frame = await connect();
    frame.socket.send('{"version":1,"type":"ping"}' + " ".repeat(4069));
    await waitFor(() => frame.frames.length === 2);
    assert.equal(frame.frames[1].type, "pong");
    frame.socket.send("x".repeat(4097));
    await waitFor(() => frame.closed() !== undefined);
    assert.equal(frame.closed(), 1009);
    const binaryFrame = await connect();
    binaryFrame.socket.send(Buffer.alloc(4097));
    await waitFor(() => binaryFrame.closed() !== undefined);
    assert.equal(binaryFrame.closed(), 1009);
    const heartbeatRest = "44444444-4444-4444-8444-444444444444";
    const heartbeat = await connect({ ...guest, restaurantId: heartbeatRest }, heartbeatRest);
    for (let index = 0; index < 3; index++) {
      heartbeat.socket.send('{"version":1,"type":"ping"}');
      await waitFor(() => heartbeat.frames.length === index + 2);
    }
    await worker.evictDurableObject("ROOMS", { name: heartbeatRest, webSockets: "hibernate" });
    heartbeat.socket.send('{"version":1,"type":"ping"}');
    await waitFor(() => heartbeat.closed() !== undefined || heartbeat.frames.length === 5);
    assert.equal(heartbeat.closed(), 1013, "heartbeat flood must close even after hibernation");
    assert.equal(heartbeat.frames.filter(frame => frame.type === "pong").length, 3);
    const futureAck = await connect();
    futureAck.socket.send(JSON.stringify({ version: 1, type: "ack", sequence: 3 }));
    await waitFor(() => futureAck.closed() !== undefined);
    assert.equal(futureAck.closed(), 1008);

    await rpc("revoke", { orderId: order });
    await publish();
    await waitFor(() => b.closed() !== undefined);
    assert.equal(b.closed(), 1008);
    await rpc("revoke", { orderId: order, revoked: false });
    const corrupt = await connect();
    await rpc("corrupt", { orderId: order });
    await worker.evictDurableObject("ROOMS", { name: restaurant, webSockets: "hibernate" });
    await publish();
    await waitFor(() => corrupt.closed() !== undefined);
    assert.equal(corrupt.closed(), 1008);
    const afterCorruption = await rpc("info", {});
    assert.equal(afterCorruption.rawSockets, 1);
    assert.equal(corrupt.frames.length, 1, "corrupted attachment never receives a business envelope");

    const lease = await connect();
    await rpc("authority", { validationAdvance: 300_000 });
    await publish();
    await waitFor(() => lease.closed() !== undefined);
    assert.equal(lease.closed(), 1008);
    await rpc("alarm", {});
    const info = await rpc("info", {});
    assert.equal(info.tickets, 0);
    assert.equal(info.sockets, 0);
    assert.equal(info.sequences, 0);
    assert.equal(info.alarm, null);

    // Fresh room scopes isolate pressure tests from the revoked/expired leases above.
    const pressureRest = "88888888-8888-4888-8888-888888888888";
    const slow = await connect({ ...guest, restaurantId: pressureRest }, pressureRest);
    for (let index = 0; index < 33; index++) await publish([order], pressureRest);
    await waitFor(() => slow.closed() !== undefined);
    assert.equal(slow.closed(), 1013);
    assert.equal(slow.frames.filter(frame => frame.topic).length, 32);

    const capRest = "77777777-7777-4777-8777-777777777777";
    for (let index = 0; index < 128; index++) {
      const uniqueOrder = `${String(Math.floor(index / 24) + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      await connect({ ...guest, restaurantId: capRest, orderId: uniqueOrder }, capRest);
    }
    const capacityTicket = await issue({ ...guest, restaurantId: capRest }, capRest);
    const full = await worker.fetch(`https://api.vapt.test/socket/${capRest}`, { headers: {
      Upgrade: "websocket", Origin: origin, "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${capacityTicket.ticket}`,
    } });
    assert.equal(full.status, 503);
    const identityRest = "66666666-6666-4666-8666-666666666666";
    for (let index = 0; index < 24; index++) await connect({ ...owner, restaurantId: identityRest,
      sessionId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111` }, identityRest);
    const sameUser = await issue({ ...owner, restaurantId: identityRest } as any, identityRest);
    assert.equal((await worker.fetch(`https://api.vapt.test/socket/${identityRest}`, { headers: {
      Upgrade: "websocket", Origin: origin, "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${sameUser.ticket}`,
    } })).status, 503);
    const ticketRest = "55555555-5555-4555-8555-555555555555";
    for (let index = 0; index < 256; index++) await issue({ ...guest, restaurantId: ticketRest }, ticketRest);
    assert.equal((await worker.fetch(`https://api.vapt.test/issue/${ticketRest}`, { method: "POST",
      body: JSON.stringify({ environment: "preview", origin, grant: { ...guest, restaurantId: ticketRest } }),
    })).status, 503);
  } finally {
    for (const socket of sockets) { try { socket.close(1000); } catch {} }
    await server.close();
  }
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, "WebSocket event arrived");
}

test("ticket admission is atomic, expiry after validation fails closed, and authority timeout is bounded", { timeout: 30_000 }, async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-realtime-test.jsonc" }] });
  try {
    await server.listen();
    const worker = server.getWorker("vapt-realtime-test");
    const rpc = async (operation: string, body: unknown) => {
      const response = await worker.fetch(`https://api.vapt.test/${operation}/${restaurant}`, {
        method: "POST", body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<any>;
    };
    const issue = () => rpc("issue", { environment: "preview", origin, grant: guest });
    const upgrade = (ticket: string) => worker.fetch(`https://api.vapt.test/socket/${restaurant}`, { headers: {
      Upgrade: "websocket", Origin: origin, "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${ticket}`,
    } });
    const single = await issue();
    const attempts = await Promise.all([upgrade(single.ticket), upgrade(single.ticket)]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [101, 403]);
    const accepted = attempts.find(response => response.status === 101)!;
    accepted.webSocket!.accept();
    accepted.webSocket!.close(1000);

    const expired = await issue();
    await rpc("advance", { milliseconds: 30_000 });
    assert.equal((await upgrade(expired.ticket)).status, 403);
    const expiresDuringValidation = await issue();
    await rpc("authority", { validationAdvance: 30_000 });
    const expiredResponse = await upgrade(expiresDuringValidation.ticket);
    if (expiredResponse.webSocket) { expiredResponse.webSocket.accept(); expiredResponse.webSocket.close(1000); }
    assert.equal(expiredResponse.status, 403, "ticket deadline is rechecked after authority await");

    const sessionGrant = { ...owner, sessionExpiresAt: Date.now() + 61_000 };
    const sessionTicket = await rpc("issue", { environment: "preview", origin, grant: sessionGrant });
    await rpc("authority", { validationAdvance: 2000 });
    assert.equal((await upgrade(sessionTicket.ticket)).status, 403, "session expires during validation");
    const timeoutTicket = await issue();
    await rpc("authority", { validationDelay: 5000 });
    const started = Date.now();
    assert.equal((await upgrade(timeoutTicket.ticket)).status, 403);
    assert.ok(Date.now() - started < 3000, "validation deadline is two seconds");
    await rpc("authority", { validationDelay: 0, unavailable: 1 });
    assert.equal((await worker.fetch(`https://api.vapt.test/issue/${restaurant}`, { method: "POST",
      body: JSON.stringify({ environment: "preview", origin, grant: guest }),
    })).status, 503);
  } finally { await server.close(); }
});

test("authorized 101 traverses Hono, rate limiting, CORS and protected operator wrapper", { timeout: 20_000 }, async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-realtime-test.jsonc" }] });
  try {
    await server.listen();
    const worker = server.getWorker("vapt-realtime-test");
    const bearer = "synthetic-operator-bearer-32-characters";
    const headers = { Origin: origin, Authorization: `Bearer ${bearer}`, "CF-Connecting-IP": "203.0.113.1", "Content-Type": "application/json", cookie: "session=owner" };
    const post = (prefix = "operator", changes: Record<string, string | undefined> = {}) => {
      const merged = new Headers(headers);
      for (const [key, value] of Object.entries(changes)) { if (value === undefined) merged.delete(key); else merged.set(key, value); }
      return worker.fetch(`https://api.vapt.test/${prefix}/v1/realtime/tickets`, {
        method: "POST", headers: Object.fromEntries(merged), body: JSON.stringify({ mode: "owner", restaurantId: restaurant }),
      });
    };
    assert.equal((await post("operator", { Authorization: undefined })).status, 401);
    assert.equal((await post("operator", { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post("operator", { Origin: undefined })).status, 403);
    assert.equal((await post("operator", { Origin: "null" })).status, 403);
    assert.equal((await post("operator", { Origin: "https://evil.vapt.test" })).status, 403);
    assert.equal((await post("operator-off")).status, 503);
    assert.equal((await post("operator-unbound")).status, 503);
    assert.equal((await post("operator-unlimited")).status, 503);
    const admitted = await post();
    assert.equal(admitted.status, 200);
    assert.equal(admitted.headers.get("cache-control"), "no-store");
    assert.equal(admitted.headers.get("access-control-allow-origin"), origin);
    const ticket = await admitted.json() as { ticket: string };
    const socketUrl = `https://api.vapt.test/operator/v1/realtime/restaurants/${restaurant}/socket`;
    const upgradeHeaders = { ...headers, Upgrade: "websocket", "Sec-WebSocket-Protocol": `vapt.realtime.v1, vapt.ticket.${ticket.ticket}` };
    for (const protocol of ["vapt.realtime.v1", "vapt.realtime.v1, vapt.ticket.short",
      `vapt.realtime.v1, vapt.ticket.${ticket.ticket}, extra`]) {
      assert.equal((await worker.fetch(socketUrl, { headers: { ...upgradeHeaders, "Sec-WebSocket-Protocol": protocol } })).status, 403);
    }
    assert.equal((await worker.fetch(socketUrl, { headers: { ...upgradeHeaders, Authorization: "Bearer invalid" } })).status, 401);
    const upgrade = await worker.fetch(socketUrl, { headers: upgradeHeaders });
    assert.equal(upgrade.status, 101);
    assert.ok(upgrade.webSocket, "original WebSocket response preserved through all layers");
    assert.equal(upgrade.headers.get("sec-websocket-protocol"), "vapt.realtime.v1");
    const frames: any[] = [];
    upgrade.webSocket!.addEventListener("message", (event: any) => frames.push(JSON.parse(event.data)));
    upgrade.webSocket!.accept();
    await waitFor(() => frames.length === 1);
    assert.equal(frames[0].type, "ready");
    assert.equal((await worker.fetch(socketUrl, { headers: upgradeHeaders })).status, 403);
    upgrade.webSocket!.close(1000);
  } finally { await server.close(); }
});
