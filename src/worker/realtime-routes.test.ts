import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "hono";
import type { ApiServices } from "../composition/api-services.js";
import { AppError } from "../lib/errors.js";
import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";

const rest = "11111111-1111-4111-8111-111111111111";
const order = "22222222-2222-4222-8222-222222222222";
const origin = "https://app.vapt.test";
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function fixture() {
  let services = 0;
  let rooms = 0;
  const admitted: any[] = [];
  const roomNames: string[] = [];
  const app = createWorkerApp(async () => {
    services++;
    return { realtimeAuthorization: { async admit(input: any) {
      admitted.push(input);
      if (input.mode === "owner") {
        if (input.headers.get("cookie") !== "session=owner") throw new AppError(401, "unauthorized", "Unauthorized");
        if (input.restaurantId !== rest) throw new AppError(403, "forbidden", "Forbidden");
        return { mode: "owner", restaurantId: rest, userId: order, sessionId: order, sessionExpiresAt: Date.now() + 300_000 };
      }
      if (input.orderId !== order || input.token !== "synthetic-public-token") throw new AppError(404, "not_found", "Order not found");
      return { mode: "order", restaurantId: rest, orderId: order, tokenFingerprint: "a".repeat(64) };
    } } } as unknown as ApiServices;
  });
  const env = { ENVIRONMENT: "preview", REALTIME_ENABLED: "true", CORS_ORIGINS: origin,
    PUBLIC_RATE_LIMIT: { async limit() { return { success: true }; } },
    RESTAURANT_REALTIME: { getByName(name: string) {
      rooms++; roomNames.push(name);
      return { async fetch() { return new Response(null, { status: 403 }); }, async issueTicket(admission: any) {
        assert.equal(admission.grant.restaurantId, rest);
        assert.equal(admission.origin, origin);
        assert.equal(admission.environment, "preview");
        return { ticket: "x".repeat(43), restaurantId: rest, expiresAt: Date.now() + 30_000 };
      } };
    } },
  } as unknown as WorkerBindings;
  const request = (body: unknown, changes: { env?: Partial<WorkerBindings>; headers?: Record<string, string | undefined> } = {}) => {
    const headers = new Headers({ Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.1", cookie: "session=owner" });
    for (const [key, value] of Object.entries(changes.headers ?? {})) {
      if (value === undefined) headers.delete(key); else headers.set(key, value);
    }
    return app.fetch(new Request("https://api.vapt.test/v1/realtime/tickets", { method: "POST", headers, body: JSON.stringify(body) }), { ...env, ...changes.env }, context);
  };
  return { app, env, request, admitted, roomNames, counts: () => ({ services, rooms }) };
}
test("realtime off and missing binding fail before services or rooms are initialized", async () => {
  const f = fixture();
  for (const value of [undefined, "false", "TRUE"]) assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { env: { REALTIME_ENABLED: value } })).status, 503);
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { env: { RESTAURANT_REALTIME: undefined } })).status, 503);
  assert.deepEqual(f.counts(), { services: 0, rooms: 0 });
});
test("strict origin and closed POST union reject extra fields and absent ingress authority", async () => {
  const f = fixture();
  for (const sent of [undefined, "null", "https://evil.vapt.test"]) {
    assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { headers: { Origin: sent } })).status, 403);
  }
  for (const body of [{ mode: "owner", restaurantId: "bad" }, { mode: "owner", restaurantId: rest, token: "secret" },
    { mode: "order", orderId: order, restaurantId: rest }, { mode: "all", restaurantId: rest }, [], null]) {
    assert.equal((await f.request(body)).status, 400);
  }
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { headers: { "Content-Type": "text/plain" } })).status, 400);
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { env: { PUBLIC_RATE_LIMIT: undefined } })).status, 503);
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { env: { PUBLIC_RATE_LIMIT: { async limit() { return { success: false }; } } } })).status, 429);
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { headers: { "CF-Connecting-IP": undefined } })).status, 429);
  assert.deepEqual(f.counts(), { services: 0, rooms: 0 });
});
test("owner/session and public order token admission use authoritative scope and no-store response", async () => {
  const f = fixture();
  assert.equal((await f.request({ mode: "owner", restaurantId: rest }, { headers: { cookie: undefined } })).status, 401);
  assert.equal((await f.request({ mode: "owner", restaurantId: order })).status, 403);
  const owner = await f.request({ mode: "owner", restaurantId: rest });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("cache-control"), "no-store");
  assert.equal(owner.headers.get("access-control-allow-origin"), origin);
  assert.equal(owner.headers.get("access-control-allow-credentials"), "true");
  assert.deepEqual(Object.keys(await owner.json()).sort(), ["expiresAt", "restaurantId", "ticket"]);
  assert.equal((await f.request({ mode: "order", orderId: order })).status, 400);
  const publicAdmission = await f.request({ mode: "order", orderId: order }, { headers: { "X-Vapt-Order-Token": "synthetic-public-token", cookie: undefined } });
  assert.equal(publicAdmission.status, 200);
  assert.equal(f.admitted.at(-1).token, "synthetic-public-token");
  assert.deepEqual(f.roomNames, [rest, rest]);
});

test("malformed socket protocols are rejected before resolving any room or initializing SQL services", async () => {
  const f = fixture();
  const token = "x".repeat(43);
  for (const protocol of [undefined, "", "vapt.realtime.v1", `vapt.ticket.${token}`,
    `vapt.realtime.v2, vapt.ticket.${token}`, "vapt.realtime.v1, vapt.realtime.v1",
    `vapt.realtime.v1, vapt.ticket.${token}, extra`, `vapt.realtime.v1, vapt.ticket.${token}, vapt.ticket.${token}`,
    "vapt.realtime.v1, vapt.ticket.short", `vapt.realtime.v1, vapt.ticket.${"x".repeat(44)}`,
    `vapt.realtime.v1, vapt.ticket.${"!".repeat(43)}`, `vapt.realtime.v1,${" ".repeat(100)}vapt.ticket.${token}`]) {
    const headers = new Headers({ Origin: origin, Upgrade: "websocket", "CF-Connecting-IP": "203.0.113.1" });
    if (protocol !== undefined) headers.set("Sec-WebSocket-Protocol", protocol);
    const response = await f.app.fetch(new Request(`https://api.vapt.test/v1/realtime/restaurants/${rest}/socket`, { headers }), f.env, context);
    assert.equal(response.status, 403);
    assert.deepEqual(f.counts(), { services: 0, rooms: 0 }, "malformed handshakes must not allocate a room");
  }
});

test("well-shaped socket pair preserves opaque ticket and original response without initializing services", async () => {
  const f = fixture();
  let received: Request | undefined;
  const original = new Response("synthetic room rejection", { status: 403, headers: { "X-Room-Response": "unchanged" } });
  const env = { ...f.env, RESTAURANT_REALTIME: { getByName(name: string) {
    assert.equal(name, rest);
    return { async fetch(request: Request) { received = request; return original; } };
  } } } as unknown as WorkerBindings;
  for (const pair of [`vapt.realtime.v1, vapt.ticket.${"x".repeat(43)}`, `vapt.ticket.${"x".repeat(43)}, vapt.realtime.v1`]) {
    const response = await f.app.fetch(new Request(`https://api.vapt.test/v1/realtime/restaurants/${rest}/socket`, {
      headers: { Origin: origin, Upgrade: "websocket", "CF-Connecting-IP": "203.0.113.1", "Sec-WebSocket-Protocol": pair },
    }), env, context);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("X-Room-Response"), "unchanged");
    assert.equal(received?.headers.get("Sec-WebSocket-Protocol"), pair);
  }
  assert.deepEqual(f.counts(), { services: 0, rooms: 0 });
});
