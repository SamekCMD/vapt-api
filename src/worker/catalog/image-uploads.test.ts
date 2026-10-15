import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { R2Bucket, SqlStorage } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import { SqliteImageBudget, type ImageReservationInput } from "./image-budget.js";
import { createImageUploads, type ImageUploadPorts } from "./image-uploads.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const input: ImageReservationInput = { restaurantId, itemId, leaseId, bytes: 123, contentType: "image/webp", now: 1_800_000_000_000, ttlMs: 300_000 };
const unavailable = (error: unknown) => error instanceof AppError && error.statusCode === 503;
function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    const statement = database.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const budget = new SqliteImageBudget(sql);
  const objects = new Map<string, { body: string; etag: string; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }>();
  const object = (key: string) => {
    const value = objects.get(key);
    return value ? { key, etag: value.etag, httpEtag: `"${value.etag}"`, size: Buffer.byteLength(value.body),
      customMetadata: value.customMetadata, httpMetadata: value.httpMetadata } : null;
  };
  let loseNextPut = false; let delayedCommit: (() => unknown) | undefined;
  let failSync = false; let now = input.now; let referenced = false;
  const signerInputs: Parameters<ImageUploadPorts["signer"]["createUploadUrl"]>[0][] = [];
  const bucket = {
    async get() { throw new Error("Image lifecycle must not download object bodies for metadata checks"); },
    async head(key: string) { return object(key); },
    async put(key: string, body: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) {
      assert.ok(budget.get(leaseId), "reservation must exist before the first R2 write");
      const commit = () => {
        const current = objects.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (options?.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
        assert.ok(options?.onlyIf, "every staging/retirement write is conditional");
        const etag = createHash("md5").update(body).digest("hex");
        objects.set(key, { body, etag, customMetadata: options?.customMetadata, httpMetadata: options?.httpMetadata });
        return object(key);
      };
      if (loseNextPut) { loseNextPut = false; delayedCommit = commit; throw new Error("synthetic lost PUT response"); }
      return commit();
    },
    async list({ prefix }: { prefix: string }) { return { truncated: false, objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => object(key)) }; },
    async delete(key: string) { objects.delete(key); },
  } as unknown as ImageUploadPorts["bucket"];
  let queue = Promise.resolve<unknown>(undefined);
  const ports: ImageUploadPorts = {
    budget, bucket, publicBaseUrl: new URL("https://assets.test/"), now: () => now,
    exclusive(work) { const result = queue.then(work); queue = result.catch(() => undefined); return result; },
    async atomic(work) {
      database.exec("BEGIN");
      try { const result = work(); database.exec("COMMIT");
        if (failSync) throw new Error("synthetic durability acknowledgement lost");
        return result;
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    },
    signer: { async createUploadUrl(value) { signerInputs.push(value); return "https://synthetic.test/signed"; } },
    async assertCanRetire() { if (referenced) throw new AppError(409, "menu_image_still_referenced", "Image is still referenced"); },
  };
  return { database, budget, objects, bucket, ports, signerInputs, uploads: createImageUploads(ports),
    losePut: () => { loseNextPut = true; }, release: () => delayedCommit?.(),
    failSync: () => { failSync = true; }, expire: () => { now += 300_001; }, reference: () => { referenced = true; },
    async clientPut(key: string, expected: string, body = "x".repeat(123)) {
      if (object(key)?.httpEtag !== expected) return false;
      objects.set(key, { body, etag: createHash("md5").update(body).digest("hex"), httpMetadata: { contentType: "image/webp" } }); return true;
    } };
}

test("durable image reservation precedes staging and signer receives its committed ETag", async () => {
  const value = fixture();
  try {
    const descriptor = await value.uploads.prepare(input);
    assert.equal(descriptor.state, "upload_required");
    if (descriptor.state !== "upload_required") assert.fail();
    assert.equal(descriptor.headers["If-Match"], `"${value.objects.get(descriptor.objectKey)!.etag}"`);
    assert.equal(value.signerInputs[0]!.ifMatch, descriptor.headers["If-Match"]);
    assert.equal(value.signerInputs[0]!.contentLength, 123);
    assert.equal(await value.clientPut(descriptor.objectKey, descriptor.headers["If-Match"]), true);
    await value.uploads.verify(leaseId);
    assert.equal(value.budget.get(leaseId)?.state, "uploaded");
    assert.equal(await value.clientPut(descriptor.objectKey, descriptor.headers["If-Match"], "y".repeat(123)), false);
    assert.equal((await value.uploads.prepare(input)).state, "uploaded", "lost client upload responses recover without overwriting the object");
  } finally { value.database.close(); }
});

test("lost reservation durability acknowledgement never produces an R2 object or a signed URL", async () => {
  const value = fixture();
  try {
    value.failSync();
    await assert.rejects(value.uploads.prepare(input), unavailable);
    assert.equal(value.objects.size, 0);
    assert.equal(value.signerInputs.length, 0);
    assert.equal(value.budget.usage(restaurantId, []), 123);
  } finally { value.database.close(); }
});

test("retiring an uncertain create keeps a fresh tiny fence so delayed PUT cannot resurrect bytes", async () => {
  const value = fixture();
  try {
    value.losePut();
    await assert.rejects(value.uploads.prepare(input), unavailable);
    assert.equal(value.signerInputs.length, 0);
    assert.equal(value.objects.size, 0, "negative read is not proof the delayed create cannot commit");
    await value.uploads.retire(leaseId);
    assert.equal(value.budget.usage(restaurantId, []), 36);
    const before = [...value.objects.values()][0]!.body;
    value.release();
    assert.equal([...value.objects.values()][0]!.body, before);
    assert.equal(value.budget.get(leaseId)?.state, "retired");
  } finally { value.database.close(); }
});

test("cleanup refuses referenced images and releases quota only after safe removal", async () => {
  const value = fixture();
  try {
    const descriptor = await value.uploads.prepare(input);
    if (descriptor.state !== "upload_required") assert.fail();
    await value.clientPut(descriptor.objectKey, descriptor.headers["If-Match"]);
    value.reference();
    await assert.rejects(value.uploads.retire(leaseId), error => error instanceof AppError && error.statusCode === 409);
    assert.ok(value.objects.has(descriptor.objectKey));
    assert.equal(value.budget.usage(restaurantId, []), 123);
  } finally { value.database.close(); }
  const safe = fixture();
  try {
    const descriptor = await safe.uploads.prepare(input);
    if (descriptor.state !== "upload_required") assert.fail();
    await safe.uploads.retire(leaseId);
    assert.equal(safe.objects.size, 0);
    assert.equal(safe.budget.usage(restaurantId, []), 0);
    assert.equal(await safe.clientPut(descriptor.objectKey, descriptor.headers["If-Match"]), false);
    await assert.rejects(safe.uploads.verify(leaseId), error => error instanceof AppError && error.statusCode === 410);
  } finally { safe.database.close(); }
});

test("expiry does not renew upload capabilities and staging is never a valid catalog image", async () => {
  const value = fixture();
  try {
    await value.uploads.prepare(input);
    await assert.rejects(value.uploads.verify(leaseId), error => error instanceof AppError && error.statusCode === 409);
    value.expire();
    await assert.rejects(value.uploads.prepare(input), error => error instanceof AppError && error.statusCode === 410);
    assert.equal(value.signerInputs.length, 1);
    assert.equal(value.budget.usage(restaurantId, []), 123);
  } finally { value.database.close(); }
});

test("incomplete tenant inventory refuses uploads before reserving or signing anything", async () => {
  const value = fixture();
  try {
    value.ports.bucket = { ...value.bucket, async list() { return { truncated: true, cursor: "repeated", objects: [] }; } } as unknown as Pick<R2Bucket, "head" | "put" | "list" | "delete">;
    await assert.rejects(createImageUploads(value.ports).prepare(input), unavailable);
    assert.equal(value.budget.get(leaseId), null);
    assert.equal(value.signerInputs.length, 0);
  } finally { value.database.close(); }
});

test("a full tenant quota rejects before creating a reservation or R2 staging object", async () => {
  const value = fixture();
  try {
    value.ports.bucket = { ...value.bucket, async list() { return { truncated: false,
      objects: [{ key: `${restaurantId}/retained-image`, size: 52_428_800 }] }; } } as unknown as ImageUploadPorts["bucket"];
    await assert.rejects(createImageUploads(value.ports).prepare(input), error => error instanceof AppError && error.statusCode === 413);
    assert.equal(value.budget.get(leaseId), null);
    assert.equal(value.signerInputs.length, 0);
    assert.equal(value.objects.size, 0);
  } finally { value.database.close(); }
});

test("recovery after an ambiguous staging PUT cannot be overwritten by its delayed first create", async () => {
  const value = fixture();
  try {
    value.losePut(); await assert.rejects(value.uploads.prepare(input), unavailable);
    const descriptor = await createImageUploads(value.ports).prepare(input);
    if (descriptor.state !== "upload_required") assert.fail();
    value.release();
    assert.equal(await value.clientPut(descriptor.objectKey, descriptor.headers["If-Match"]), true);
    await value.uploads.verify(leaseId);
    await value.uploads.retire(leaseId);
    assert.equal(value.objects.get(descriptor.objectKey)?.body.length, 36, "uncertain creator history requires a retained fence");
    assert.equal(value.budget.usage(restaurantId, []), 36);
    assert.equal(await value.clientPut(descriptor.objectKey, descriptor.headers["If-Match"]), false);
  } finally { value.database.close(); }
});

test("wrong-size or wrong-type uploaded objects are not accepted as catalog images", async () => {
  const value = fixture();
  try {
    const descriptor = await value.uploads.prepare(input);
    if (descriptor.state !== "upload_required") assert.fail();
    const attempts = [
      { body: "short", etag: "wrong-size", httpMetadata: { contentType: "image/webp" } },
      { body: "x".repeat(123), etag: "wrong-type", httpMetadata: { contentType: "text/html" } },
    ];
    for (const object of attempts) {
      value.objects.set(descriptor.objectKey, object);
      await assert.rejects(value.uploads.verify(leaseId), error => error instanceof AppError && error.statusCode === 409);
      assert.equal(value.budget.get(leaseId)?.state, "staged");
    }
  } finally { value.database.close(); }
});
