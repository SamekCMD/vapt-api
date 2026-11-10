import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerBindings } from "../environment.js";
import type { CatalogState } from "../../modules/catalog-publication/contracts.js";
import { createPublicCatalogSockets } from "./public-sockets.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const origin = "https://app.vapt.test";
class Socket {
  frames: string[] = []; attachment: unknown; code: number | undefined;
  send(value: string) { this.frames.push(value); }
  close(code: number) { this.code = code; }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
function fixture() {
  const sockets: Socket[] = []; let version = "12"; let reads = 0;
  const env = { ENVIRONMENT: "preview", CORS_ORIGINS: origin, PUBLIC_CATALOG_READER_ENABLED: "true", PUBLIC_CATALOG_WRITER_ENABLED: "true" } as WorkerBindings;
  const core = createPublicCatalogSockets({ env, belongs: id => id === restaurantId,
    readRegistration: async id => { assert.equal(id, restaurantId); reads++; return { version, canonicalSlug: "bistro" }; },
    sockets: () => sockets, accept: socket => { sockets.push(socket); },
    pair: () => ({ client: "synthetic-client", server: new Socket() }),
  });
  const request = (expected = "11") => new Request(`https://catalog.internal/v1/catalog/restaurants/${restaurantId}/socket`, { headers: {
    Origin: origin, Upgrade: "websocket", "X-Vapt-Catalog-Version": expected,
  } });
  const state = (revision: string) => ({ version: revision, catalog: { restaurant: { id: restaurantId } } }) as CatalogState;
  return { core, sockets, request, state, reads: () => reads, publish: (value: string) => { version = value; } };
}

test("readyClosesGetUpgradeRace and publicHasNoPrivateLease", async () => {
  const f = fixture(); assert.equal(f.reads(), 0, "construction performs no external reads");
  assert.equal(await f.core.connect(f.request()), "synthetic-client");
  assert.deepEqual(JSON.parse(f.sockets[0]!.frames[0]!), { protocol: "vapt.catalog.v1", type: "ready", version: "12", canonicalSlug: "bistro" });
  assert.deepEqual(f.sockets[0]!.attachment, { protocol: "vapt.catalog.v1", restaurantId, environment: "preview", lastSentVersion: "12" });
  assert.equal(f.reads(), 1);
});

test("only a fresh published R2 registration can advance public signals", async () => {
  const f = fixture(); await f.core.connect(f.request());
  await assert.rejects(f.core.publish(f.state("13")), { statusCode: 503 });
  assert.equal(f.sockets[0]!.frames.length, 1, "never advertise a version ahead of R2 ready");
  f.publish("9007199254740993"); await f.core.publish(f.state("13"));
  await f.core.publish(f.state("13"));
  assert.deepEqual(JSON.parse(f.sockets[0]!.frames[1]!), { protocol: "vapt.catalog.v1", type: "catalog_changed", version: "9007199254740993", canonicalSlug: "bistro" });
  assert.equal(f.sockets[0]!.frames.length, 2, "duplicates never produce regressive or repeated events");
  assert.equal((f.sockets[0]!.attachment as any).lastSentVersion, "9007199254740993");
});

test("corrupt or cross-tenant hibernation attachments never receive a signal", async () => {
  const f = fixture(); await f.core.connect(f.request());
  f.sockets[0]!.attachment = { ...(f.sockets[0]!.attachment as object), restaurantId: "22222222-2222-4222-8222-222222222222" };
  f.publish("13"); await f.core.publish(f.state("13"));
  assert.equal(f.sockets[0]!.code, 1008); assert.equal(f.sockets[0]!.frames.length, 1);
});

test("socket 201 is rejected without accepting or evicting an existing visitor", async () => {
  const f = fixture(); for (let i = 0; i < 200; i++) await f.core.connect(f.request());
  await assert.rejects(f.core.connect(f.request()), { statusCode: 503 });
  assert.equal(f.sockets.length, 200); assert.ok(f.sockets.every(socket => socket.code === undefined));
});

test("unpublished or malformed gateway registration cannot open a socket", async () => {
  const f = fixture();
  for (const expected of ["", "01", "99999999999999999999999"]) await assert.rejects(f.core.connect(f.request(expected)), { statusCode: 400 });
  await assert.rejects(f.core.connect(f.request("13")), { statusCode: 503 });
  assert.equal(f.sockets.length, 0);
});

test("publicSocketCannotWrite: all JS frames close, UTF8 and binary limits apply", async () => {
  for (const [frame, code] of [["{\"type\":\"submit\"}", 1008], ["é".repeat(257), 1009], [new ArrayBuffer(1), 1003]] as const) {
    const f = fixture(); await f.core.connect(f.request()); const reads = f.reads();
    f.core.message(f.sockets[0]!, frame);
    assert.equal(f.sockets[0]!.code, code); assert.equal(f.sockets[0]!.frames.length, 1);
    assert.equal(f.sockets[0]!.attachment, null); assert.equal(f.reads(), reads);
  }
  const idle = fixture(); await idle.core.publish(idle.state("13")); assert.equal(idle.reads(), 0, "no subscribers means no R2 read either");
});
