import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "hono";
import type { ApiServices } from "../../composition/api-services.js";
import { AppError } from "../../lib/errors.js";
import { allocateOnboardingRestaurantId } from "../../modules/catalog-publication/policy.js";
import type { CatalogCommand, CommandReceipt } from "../../modules/catalog-publication/contracts.js";
import { createWorkerApp } from "../app.js";
import type { WorkerBindings } from "../environment.js";

const userId = "11111111-1111-4111-8111-111111111111";
const restaurantId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const origin = "https://app.vapt.test";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const menuInput = { name: "Prato", price: "12.00", description: null, category: "Pratos", available: true,
  imageUrl: null, availableFrom: null, availableUntil: null, badge: null, isChefSuggestion: false,
  prepTimeMinutes: null, variations: [] };

function fixture(options: { enabled?: boolean; noRestaurant?: boolean; pending?: boolean } = {}) {
  const commands: CatalogCommand[] = [];
  const roomNames: string[] = [];
  let authReads = 0; let legacyWrites = 0;
  const imageCalls: { action: string; input: unknown }[] = [];
  const scope = { id: restaurantId, name: "Bistrô" };
  const receipt = (operation: string, restaurant: string): CommandReceipt => ({ operationId: operation, restaurantId: restaurant,
    phase: options.pending ? "committed" : "ready", version: "11", committed: true, retryable: Boolean(options.pending) });
  const services = {
    authRuntime: { async getSession(headers: Headers) {
      authReads++;
      return headers.get("cookie") === "session=owner" ? { user: { id: userId, email: "synthetic@example.invalid", name: "Test" },
        session: { id: sessionId, userId, expiresAt: new Date("2030-01-01") } } : null;
    } },
    restaurants: {
      async getOwnedRestaurant(owner: string) {
        assert.equal(owner, userId);
        if (options.noRestaurant) throw new AppError(404, "not_found", "Restaurant not found");
        return scope;
      },
      async createOwnedRestaurant() { legacyWrites++; return { legacy: true }; },
      async updateOwnedRestaurant() { legacyWrites++; return { legacy: true }; },
    },
    menu: {
      async createOwnedMenuItem() { legacyWrites++; return { legacy: true }; },
      async updateOwnedMenuItem() { legacyWrites++; return { legacy: true }; },
      async deleteOwnedMenuItem() { legacyWrites++; },
    },
    menuImages: {
      async prepareUpload() { legacyWrites++; return { legacy: true }; },
      async delete() { legacyWrites++; },
    },
  } as unknown as ApiServices;
  const env = { ENVIRONMENT: "preview", CORS_ORIGINS: origin,
    PUBLIC_CATALOG_WRITER_ENABLED: options.enabled === false ? "false" : "true",
    AUTH_RATE_LIMIT: { async limit() { return { success: true }; } },
    STORAGE_RATE_LIMIT: { async limit() { return { success: true }; } }, R2_BUCKET_NAME: "synthetic-bucket",
    PUBLIC_CATALOG_COORDINATOR: {
      idFromName(name: string) { roomNames.push(name); return name; },
      get() { return {
        async prepareImage(input: unknown) { imageCalls.push({ action: "prepare", input }); return { ok: true, value: {
          state: "upload_required", method: "PUT", publicUrl: "https://assets.test/unique", objectKey: "unique", uploadUrl: "https://synthetic.test/signed",
          headers: { "Content-Type": "image/webp", "If-Match": '"synthetic-etag"' }, expiresInSeconds: 300,
        } }; },
        async retireImage(input: unknown) { imageCalls.push({ action: "retire", input }); return { ok: true, value: undefined }; },
        async submit(command: CatalogCommand) { commands.push(command); return { ok: true, value: { receipt: receipt(command.operationId, command.restaurantId), result: { saved: true } } }; },
        async status(access: { operationId: string; restaurantId: string }) { return { ok: true, value: receipt(access.operationId, access.restaurantId) }; },
        async retry(access: { operationId: string; restaurantId: string }) { return { ok: true, value: receipt(access.operationId, access.restaurantId) }; },
      }; },
    },
  } as unknown as WorkerBindings;
  const app = createWorkerApp(async () => services);
  const request = (route: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`https://api.vapt.test${route}`, {
    method, headers: { Origin: origin, "CF-Connecting-IP": "203.0.113.1", Cookie: "session=owner",
      "Content-Type": "application/json", "Idempotency-Key": operationId, "X-Vapt-Catalog-Protocol": "1", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env, execution);
  return { request, commands, roomNames, env, imageCalls, authReads: () => authReads, legacyWrites: () => legacyWrites };
}

test("image upload uses the same owner-scoped coordinator and sends no cookie/email in the lease", async () => {
  const value = fixture();
  const response = await value.request(`/restaurants/${restaurantId}/menu-items/${sessionId}/image/upload`, "POST", { contentType: "image/webp", contentLength: 123 });
  assert.equal(response.status, 200);
  assert.deepEqual(value.imageCalls, [{ action: "prepare", input: { restaurantId, itemId: sessionId, leaseId: operationId,
    actor: { userId, sessionId, sessionExpiresAt: new Date("2030-01-01").getTime() }, contentType: "image/webp", contentLength: 123 } }]);
  assert.equal(value.authReads(), 1); assert.equal(value.legacyWrites(), 0);
});

test("image retirement requires an explicit tenant image key and never falls through to mutable legacy deletion", async () => {
  const value = fixture(); const path = `/restaurants/${restaurantId}/menu-items/${sessionId}/image`;
  assert.equal((await value.request(path, "DELETE")).status, 400);
  const objectKey = `${restaurantId}/${sessionId}/${operationId}`;
  assert.equal((await value.request(`${path}?objectKey=${encodeURIComponent(objectKey)}`, "DELETE")).status, 204);
  assert.equal(value.imageCalls[0]?.action, "retire");
  assert.equal(value.legacyWrites(), 0);
});

test("foreign/anonymous/oversized image requests never select a coordinator; disabled flag preserves legacy", async () => {
  const value = fixture(); const path = `/restaurants/${restaurantId}/menu-items/${sessionId}/image/upload`;
  assert.equal((await value.request(path, "POST", { contentType: "image/webp", contentLength: 1_048_577 })).status, 400);
  assert.equal((await value.request(path, "POST", { contentType: "image/webp", contentLength: 123 }, { Cookie: "session=revoked" })).status, 401);
  assert.equal((await value.request(`/restaurants/${operationId}/menu-items/${sessionId}/image/upload`, "POST", { contentType: "image/webp", contentLength: 123 })).status, 403);
  assert.equal(value.roomNames.length, 0);
  const legacy = fixture({ enabled: false });
  assert.equal((await legacy.request(path, "POST", { contentType: "image/webp", contentLength: 123 })).status, 200);
  assert.equal(legacy.legacyWrites(), 1); assert.equal(legacy.imageCalls.length, 0);
});

test("allCatalogRoutesUseDurableWriter sends validated commands and only verified secret-free actor metadata", async () => {
  const cases = [
    ["POST", "/onboarding", { restaurantName: "Bistrô", slug: "bistro", dishName: "Prato", dishPrice: "12.00" }, "onboarding", 201],
    ["PATCH", "/restaurants/me", { name: "Bistrô", cnpj: "synthetic-private" }, "restaurant.patch", 200],
    ["POST", "/restaurants/me/menu-items", menuInput, "item.create", 201],
    ["PATCH", `/restaurants/me/menu-items/${sessionId}`, { available: false }, "item.patch", 200],
    ["DELETE", `/restaurants/me/menu-items/${sessionId}`, undefined, "item.delete", 200],
  ] as const;
  for (const [method, route, body, type, expectedStatus] of cases) {
    const value = fixture({ noRestaurant: type === "onboarding" });
    const response = await value.request(route, method, body);
    assert.equal(response.status, expectedStatus, type);
    const payload = await response.json() as { receipt: CommandReceipt };
    assert.equal(payload.receipt.phase, "ready");
    assert.equal(value.commands[0]?.mutation.type, type);
    assert.deepEqual(value.commands[0]?.actor, { userId, sessionId, sessionExpiresAt: new Date("2030-01-01").getTime() });
    assert.equal(JSON.stringify(value.commands[0]).includes("session=owner"), false);
    assert.equal(JSON.stringify(value.commands[0]).includes("synthetic@example.invalid"), false);
    assert.equal(value.authReads(), 1, "one fresh auth resolution, not a second SQL-backed session lookup");
    assert.equal(value.legacyWrites(), 0);
  }
});

test("privateOnlyDoesNotPublish and disabled feature preserve existing mutations", async () => {
  const privateOnly = fixture();
  assert.equal((await privateOnly.request("/restaurants/me", "PATCH", { cnpj: "synthetic" })).status, 200);
  assert.equal(privateOnly.commands.length, 0); assert.equal(privateOnly.legacyWrites(), 1);
  const disabled = fixture({ enabled: false });
  const response = await disabled.request("/restaurants/me/menu-items", "POST", menuInput, { "X-Vapt-Catalog-Protocol": "" });
  assert.deepEqual(await response.json(), { legacy: true });
  assert.equal(disabled.commands.length, 0); assert.equal(disabled.legacyWrites(), 1);
});

test("pending commit returns an explicit 202, never a fake published response", async () => {
  const value = fixture({ pending: true });
  const response = await value.request("/restaurants/me", "PATCH", { name: "Novo" });
  assert.equal(response.status, 202);
  assert.equal((await response.json() as { receipt: CommandReceipt }).receipt.phase, "committed");
});

test("onboardingRetryFindsSameRoom even when a caller changes its operation key", async () => {
  const value = fixture({ noRestaurant: true });
  const input = { restaurantName: "Bistrô", slug: "bistro", dishName: "Prato", dishPrice: "12.00" };
  await value.request("/onboarding", "POST", input);
  await value.request("/onboarding", "POST", input, { "Idempotency-Key": sessionId });
  const id = await allocateOnboardingRestaurantId(userId, operationId);
  assert.deepEqual(value.roomNames, [`preview:${id}`, `preview:${id}`]);
  assert.notEqual(value.commands[0].operationId, value.commands[1].operationId);
});

test("bad actor, idempotency key, body tenant fields and unsupported protocol never reach a room", async () => {
  const invalidHeaders: Record<string, string>[] = [{ Cookie: "session=revoked" }, { "Idempotency-Key": "bad" }, { "X-Vapt-Catalog-Protocol": "2" }];
  for (const headers of invalidHeaders) {
    const value = fixture();
    const response = await value.request("/restaurants/me", "PATCH", { name: "Novo" }, headers);
    assert.ok([400, 401].includes(response.status)); assert.equal(value.roomNames.length, 0);
  }
  const value = fixture();
  assert.equal((await value.request("/restaurants/me", "PATCH", { name: "Novo", ownerId: userId })).status, 400);
  assert.equal(value.roomNames.length, 0);
});

test("authenticated status and rebuild never accept an arbitrary restaurant target", async () => {
  const value = fixture();
  assert.equal((await value.request(`/restaurants/me/catalog-operations/${operationId}`, "GET")).status, 200);
  assert.equal((await value.request(`/restaurants/me/catalog-operations/${operationId}/retry`, "POST", {})).status, 200);
  assert.equal((await value.request("/restaurants/me/catalog/rebuild", "POST", {})).status, 200);
  assert.equal(value.commands.at(-1)?.mutation.type, "rebuild");
  assert.equal((await value.request("/restaurants/me/catalog/rebuild", "POST", { restaurantId: sessionId })).status, 400);
  assert.equal((await value.request(`/restaurants/me/catalog-operations/${operationId}?restaurantId=${sessionId}`, "GET")).status, 403);
});

test("preflight permits the explicit catalog protocol header without resolving a session", async () => {
  const value = fixture();
  const response = await value.request("/restaurants/me", "OPTIONS");
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /X-Vapt-Catalog-Protocol/i);
  assert.equal(value.authReads(), 0);
});
