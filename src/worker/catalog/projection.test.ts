import assert from "node:assert/strict";
import test from "node:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import type { CommittedCommand } from "../../modules/catalog-publication/transaction.js";
import { createCatalogProjection } from "./projection.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const prefix = "catalog/v1/preview/";
const manifestKey = `${prefix}restaurants/${restaurantId}/manifest.json`;
const snapshotKey = (version: string) => `${prefix}restaurants/${restaurantId}/snapshots/${version}.json`;
const unavailable = (error: unknown) => error instanceof AppError && error.statusCode === 503;

function committed(version: string, slug = "bistro", id = restaurantId, previousSlug: string | null = null): CommittedCommand {
  return { receipt: { operationId: otherId, restaurantId: id, phase: "committed", version, committed: true, retryable: true },
    result: { cnpj: "synthetic-private", ownerId: otherId }, previousSlug,
    state: { version, catalog: { restaurant: { id, name: "Bistrô", slug,
      whatsapp: null, address: null, phone: null, hours: null, description: null, primaryColor: "#123456",
      secondaryColor: "#654321", fontFamily: "modern", logoUrl: null, totalTables: 1, maxTables: 1,
      paymentMode: "open_tab", maxPendingOrders: 3, localEnabled: true, deliveryEnabled: true,
      updatedAt: "2026-10-15T00:00:00.000Z" }, items: [] } } };
}

// External I/O double: atomic conditional writes, lost responses and delayed commits.
function bucketFixture() {
  const objects = new Map<string, { body: string; etag: string }>();
  const writes: string[] = [];
  let serial = 0;
  let failKey: string | undefined;
  let lostResponseKey: string | undefined;
  let delayedCommit: (() => unknown) | undefined;
  let intercept: ((key: string, body: string) => Promise<void> | void) | undefined;
  const object = (key: string) => {
    const value = objects.get(key);
    return value ? { key, etag: value.etag, size: new TextEncoder().encode(value.body).byteLength,
      json: async () => JSON.parse(value.body) } : null;
  };
  const bucket = {
    async get(key: string) { return object(key); },
    async put(key: string, body: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      await intercept?.(key, body);
      if (key === failKey) throw new Error("synthetic storage failure");
      const commit = () => {
        const current = objects.get(key);
        if ((options?.onlyIf?.etagDoesNotMatch === "*" && current)
          || (options?.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches)) return null;
        assert.ok(options?.onlyIf, "Every projection write must be conditional");
        objects.set(key, { body, etag: String(++serial) }); writes.push(key); return object(key);
      };
      if (key === lostResponseKey) {
        lostResponseKey = undefined; delayedCommit = commit; throw new Error("synthetic lost response, write still in flight");
      }
      return commit();
    },
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      const keys = [...objects.keys()].filter(key => key.startsWith(options.prefix)).sort();
      const offset = Number(options.cursor ?? 0);
      const selected = keys.slice(offset, offset + options.limit);
      return { objects: selected.map(key => object(key)), truncated: offset + selected.length < keys.length,
        cursor: String(offset + selected.length), delimitedPrefixes: [] };
    },
  } as unknown as Pick<R2Bucket, "get" | "put" | "list">;
  return { bucket, objects, writes, fail: (key?: string) => { failKey = key; },
    loseResponse: (key: string) => { lostResponseKey = key; },
    releaseDelayedCommit: () => delayedCommit?.(),
    intercept: (handler?: typeof intercept) => { intercept = handler; } };
}

test("snapshotBeforeManifest serves only public state after immutable object and mappings are ready", async () => {
  const fixture = bucketFixture();
  fixture.intercept(key => { if (key === manifestKey) assert.ok(fixture.objects.has(snapshotKey("11"))); });
  const projection = createCatalogProjection(fixture.bucket, "preview");
  const outcome = committed("11");
  assert.deepEqual(await projection.publish(outcome), outcome.state);
  assert.deepEqual(await projection.readBySlug("bistro"), outcome.state);
  assert.deepEqual(await projection.readRegistration(restaurantId), { version: "11", canonicalSlug: "bistro" });
  assert.ok(fixture.writes.indexOf(snapshotKey("11")) < fixture.writes.indexOf(manifestKey));
  assert.equal([...fixture.objects.values()].some(value => /cnpj|ownerId|synthetic-private/.test(value.body)), false);
});

test("latePutCannotRegress rejects a delayed manifest CAS after a newer publication", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  await projection.publish(committed("11"));
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  fixture.intercept(async (key, body) => {
    if (key === manifestKey && JSON.parse(body).version === "12") { arrived(); await barrier; }
  });
  const old = projection.publish(committed("12", "bistro", restaurantId, "bistro"));
  const oldResult = old.then(() => null, error => error);
  await waiting;
  await projection.publish(committed("13", "bistro", restaurantId, "bistro"));
  release();
  assert.ok(unavailable(await oldResult));
  assert.equal((await projection.readBySlug("bistro")).version, "13");
  assert.equal((await projection.publish(committed("12"))).version, "13", "retry observes the superseding ready version");
});

test("slugReuseFenced never lets an old tombstone replace a new restaurant's mapping", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  await projection.publish(committed("11"));
  let release!: () => void; let arrived!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  fixture.intercept(async (key, body) => {
    if (key === `${prefix}slugs/bistro.json` && JSON.parse(body).tombstone === true) { arrived(); await barrier; }
  });
  const rename = projection.publish(committed("12", "novo-bistro", restaurantId, "bistro"));
  await waiting;
  await projection.publish(committed("13", "bistro", otherId));
  release(); await rename;
  assert.equal((await projection.readBySlug("bistro")).catalog.restaurant.id, otherId);
  assert.equal((await projection.readBySlug("novo-bistro")).catalog.restaurant.id, restaurantId);
});

test("partialManifestIs503 retries safely; unknown slugs never bootstrap", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  fixture.fail(manifestKey);
  await assert.rejects(projection.publish(committed("11")), unavailable);
  await assert.rejects(projection.readBySlug("bistro"), unavailable);
  await assert.rejects(projection.readBySlug("unknown"), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  fixture.fail();
  await projection.publish(committed("11"));
  assert.equal((await projection.readBySlug("bistro")).version, "11");
});

test("pruneKeepsReferenced retires old payloads without reopening an absent key to late create-once writes", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  for (const version of ["11", "12", "13"]) await projection.publish(committed(version));
  await projection.prune(restaurantId);
  assert.equal(JSON.parse(fixture.objects.get(snapshotKey("12"))!.body).version, "12");
  assert.equal(JSON.parse(fixture.objects.get(snapshotKey("13"))!.body).version, "13");
  assert.deepEqual(JSON.parse(fixture.objects.get(snapshotKey("11"))!.body), { retired: true, version: "11" });
  const late = await fixture.bucket.put(snapshotKey("11"), JSON.stringify(committed("11").state), { onlyIf: { etagDoesNotMatch: "*" } });
  assert.equal(late, null);
  assert.equal((await projection.readBySlug("bistro")).version, "13");
});

test("malformed/private projection data is never accepted as a published success", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  const invalid = committed("11");
  Object.assign(invalid.state.catalog.restaurant, { cnpj: "private" });
  await assert.rejects(projection.publish(invalid), unavailable);
  assert.equal(fixture.objects.size, 0);
  await projection.publish(committed("11"));
  fixture.objects.get(snapshotKey("11"))!.body = "{truncated";
  await assert.rejects(projection.readBySlug("bistro"), unavailable);
  const production = createCatalogProjection(fixture.bucket, "production");
  await assert.rejects(production.readBySlug("bistro"), (error: unknown) => error instanceof AppError && error.statusCode === 404);
});

test("a negative read after a lost PUT response is not treated as final absence", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  fixture.loseResponse(snapshotKey("11"));
  await assert.rejects(projection.publish(committed("11")), unavailable);
  assert.equal(await fixture.bucket.get(snapshotKey("11")), null);
  fixture.releaseDelayedCommit(); // The original request can still commit after that negative read.
  assert.deepEqual(await projection.publish(committed("11")), committed("11").state);
  assert.deepEqual(await projection.readBySlug("bistro"), committed("11").state);
});

test("pruning paginates bounded work while retaining only two complete snapshot payloads", async () => {
  const fixture = bucketFixture(); const projection = createCatalogProjection(fixture.bucket, "preview");
  for (let revision = 1; revision <= 105; revision++) await projection.publish(committed(String(revision)));
  const first = await projection.prune(restaurantId);
  assert.equal(typeof first.cursor, "string");
  assert.deepEqual(await projection.prune(restaurantId, first.cursor), {});
  const complete = [...fixture.objects.entries()].filter(([key, value]) => key.includes("/snapshots/") && !JSON.parse(value.body).retired);
  assert.deepEqual(complete.map(([, value]) => JSON.parse(value.body).version), ["104", "105"]);
  assert.equal((await projection.readBySlug("bistro")).version, "105");
});
