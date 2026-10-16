import assert from "node:assert/strict";
import test from "node:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { ExecutionContext } from "hono";
import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";
import type { CommittedCommand } from "../modules/catalog-publication/transaction.js";
import { createCatalogProjection } from "./catalog/projection.js";
const restaurantId = "11111111-1111-4111-8111-111111111111";
const origin = "https://app.vapt.test";
const state: CommittedCommand["state"] = { version: "9007199254740993", catalog: { restaurant: { id: restaurantId, name: "Bistrô", slug: "bistro",
  whatsapp: null, address: null, phone: null, hours: null, description: null, primaryColor: "#123456", secondaryColor: "#654321", fontFamily: "modern", logoUrl: null,
  totalTables: 1, maxTables: 1, paymentMode: "open_tab", maxPendingOrders: 3, localEnabled: true, deliveryEnabled: true, updatedAt: "2026-10-15T00:00:00Z" }, items: [] } };
async function fixture() {
  const objects = new Map<string, string>(); let serial = 0;
  const bucket = { async get(key: string) { const body = objects.get(key); return body === undefined ? null : { etag: "test", size: Buffer.byteLength(body), json: async () => JSON.parse(body) }; },
    async put(key: string, body: string) { objects.set(key, body); return { etag: String(++serial) }; },
    async list() { return { objects: [], truncated: false }; },
  } as unknown as Pick<R2Bucket, "get" | "put" | "list">;
  await createCatalogProjection(bucket, "preview").publish({ receipt: { operationId: restaurantId, restaurantId, phase: "committed", version: state.version, committed: true, retryable: true }, state, result: null, previousSlug: null });
  let services = 0; const rooms: string[] = []; const ingressHeaders: Headers[] = []; let allowRate = true;
  const app = createWorkerApp(async () => { services++; throw new Error("Public catalog must never initialize SQL/auth/services"); });
  const env = { ENVIRONMENT: "preview", PUBLIC_CATALOG_READER_ENABLED: "true", PUBLIC_CATALOG_WRITER_ENABLED: "true", CORS_ORIGINS: origin,
    PUBLIC_RATE_LIMIT: { async limit() { return { success: allowRate }; } }, R2_BUCKET: bucket,
    PUBLIC_CATALOG_COORDINATOR: { idFromName(name: string) { rooms.push(name); return name; }, get() { return { async fetch(request: Request) {
      ingressHeaders.push(request.headers); return new Response(null, { status: 200, headers: { "X-Synthetic-Upgrade": "stub-only-not-real101" } });
    } }; } },
  } as unknown as WorkerBindings;
  const request = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`https://api.test${path}`, { headers: { Origin: origin, "CF-Connecting-IP": "203.0.113.1", ...headers } }), env, { waitUntil() {} } as unknown as ExecutionContext);
  return { env, objects, rooms, ingressHeaders, request, services: () => services, denyRate: () => { allowRate = false; } };
}
test("published GET legacy/state uses only R2 and no-store, including unknown and partial errors", async () => {
  const value = await fixture();
  for (const [path, expected] of [["/public/restaurants/bistro/catalog", state.catalog], ["/public/restaurants/bistro/catalog-state", state]] as const) {
    const response = await value.request(path); assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.deepEqual(await response.json(), expected);
  }
  assert.equal((await value.request("/public/restaurants/unknown/catalog-state")).status, 404);
  value.objects.delete(`catalog/v1/preview/restaurants/${restaurantId}/snapshots/${state.version}.json`);
  assert.equal((await value.request("/public/restaurants/bistro/catalog-state")).status, 503);
  assert.equal(value.services(), 0); assert.deepEqual(value.rooms, []);
});
test("unknown restaurant, invalid origin/upgrade and exhausted rate never create a public room", async () => {
  const value = await fixture(); const socket = `/v1/catalog/restaurants/${restaurantId}/socket`;
  assert.equal((await value.request(socket)).status, 400);
  assert.equal((await value.request(socket, { Origin: "https://foreign.test", Upgrade: "websocket" })).status, 403);
  assert.equal((await value.request(socket.replace(restaurantId, "22222222-2222-4222-8222-222222222222"), { Upgrade: "websocket" })).status, 404);
  value.denyRate(); assert.equal((await value.request(socket, { Upgrade: "websocket" })).status, 429);
  assert.deepEqual(value.rooms, []); assert.equal(value.services(), 0);
});
test("published socket ingress selects only its scoped room and strips private browser headers", async () => {
  const value = await fixture();
  const response = await value.request(`/v1/catalog/restaurants/${restaurantId}/socket`, { Upgrade: "websocket", Cookie: "synthetic-private-cookie", Authorization: "Bearer synthetic-private" });
  assert.equal(response.headers.get("X-Synthetic-Upgrade"), "stub-only-not-real101");
  assert.deepEqual(value.rooms, [`preview:${restaurantId}`]);
  assert.equal(value.ingressHeaders[0]?.has("cookie"), false); assert.equal(value.ingressHeaders[0]?.has("authorization"), false);
  assert.equal(value.services(), 0);
});
