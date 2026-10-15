import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import type { Database } from "../../lib/database.js";
import type { CatalogCommand, CatalogState } from "../../modules/catalog-publication/contracts.js";
import { SqliteImageBudget } from "./image-budget.js";
import { createCatalogImageService, type CatalogImageServicePorts } from "./image-service.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const now = 1_800_000_000_000;
const actor = { userId, sessionId, sessionExpiresAt: now + 600_000 };
const access = { restaurantId, itemId, actor };
const pending = (error: unknown) => error instanceof AppError && error.statusCode === 409;
// Query boundary fixture, not proof of real PostgreSQL lock/isolation behavior.
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...values: SQLInputValue[]) {
    const statement = sqlite.prepare(query);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const budget = new SqliteImageBudget(sql);
  const lease = budget.reserve({ ...access, leaseId: sessionId, contentType: "image/webp", bytes: 123, now, ttlMs: 300_000 }, []);
  budget.stageAttempt(sessionId); budget.staged(sessionId, "staging-etag");
  let transaction = false; let ownerLocked = false; let sessionLocked = false; let sessionValid = true;
  let owns = true; let pendingCommands = false; let revision = "12";
  const calls: string[] = []; const deleted: string[] = [];
  let imagePresent = true;
  const client = { async query(query: string, values: unknown[] = []) {
    calls.push(query);
    if (query === "BEGIN") { transaction = true; return { rows: [] }; }
    if (query === "COMMIT" || query === "ROLLBACK") { transaction = false; ownerLocked = false; sessionLocked = false; return { rows: [] }; }
    if (query.includes("pg_advisory_xact_lock")) { assert.deepEqual(values, [`catalog:owner:${userId}`]); ownerLocked = true; return { rows: [] }; }
    if (query.includes('from better_auth."session"')) { sessionLocked = sessionValid; assert.deepEqual(values, [sessionId, userId]); return { rows: sessionValid ? [{ id: sessionId }] : [] }; }
    if (query.includes("catalog_publication_revisions")) return { rows: [{ version: revision }] };
    if (query.includes("from public.menu_items")) return { rows: [{ id: itemId }] };
    if (query.includes("from public.restaurants")) { assert.deepEqual(values, [restaurantId, userId]); return { rows: owns ? [{ id: restaurantId }] : [] }; }
    throw new Error(`Unexpected SQL: ${query}`);
  }, release() { calls.push("RELEASE"); } };
  const database = { connect: async () => client } as unknown as Database;
  const retained = [{ version: "12", catalog: { restaurant: { id: restaurantId, logoUrl: null }, items: [] } },
    { version: "11", catalog: { restaurant: { id: restaurantId, logoUrl: null }, items: [] } }] as unknown as CatalogState[];
  const ports: CatalogImageServicePorts = {
    database, budget, publicBaseUrl: new URL("https://assets.test/"), ttlMs: 300_000, now: () => now,
    exclusive: work => work(), async atomic(work) { return work(); },
    hasUnresolvedCommands: () => pendingCommands,
    projection: { async readRetainedCatalogs() { return retained; } },
    signer: { async createUploadUrl() { throw new Error("Not needed"); } },
    bucket: {
      async list() { calls.push("R2_LIST"); assert.ok(transaction && ownerLocked && sessionLocked); return { truncated: false,
        objects: [{ key: lease.objectKey, size: 123 }] }; },
      async head() { return imagePresent ? { etag: "image-etag", httpEtag: '"image-etag"', size: 123, httpMetadata: { contentType: "image/webp" } } : null; },
      async delete(key: string) {
        assert.ok(transaction && ownerLocked && sessionLocked, "SQL owner/session locks must remain held through physical deletion");
        imagePresent = false; deleted.push(key);
      },
    } as unknown as CatalogImageServicePorts["bucket"],
  };
  return { sqlite, ports, lease, deleted, retained, calls, service: createCatalogImageService(ports),
    revoke: () => { sessionValid = false; }, foreign: () => { owns = false; },
    pending: () => { pendingCommands = true; }, revision: (value: string) => { revision = value; } };
}

test("prepare revalidates session, owner and item before R2 inventory or issuing a capability", async () => {
  const value = fixture();
  try {
    const result = await value.service.prepare({ ...access, leaseId: sessionId, contentType: "image/webp", contentLength: 123 });
    assert.equal(result.state, "uploaded");
    assert.ok(value.calls.findIndex(query => query.includes("from public.menu_items")) < value.calls.indexOf("R2_LIST"));
    const reads = value.calls.filter(call => call === "R2_LIST").length;
    value.revoke();
    await assert.rejects(value.service.prepare({ ...access, leaseId: sessionId, contentType: "image/webp", contentLength: 123 }),
      error => error instanceof AppError && error.statusCode === 401);
    assert.equal(value.calls.filter(call => call === "R2_LIST").length, reads);
  } finally { value.sqlite.close(); }
});

test("retirement holds verified SQL owner/session locks through R2 removal and releases quota afterward", async () => {
  const value = fixture();
  try {
    await value.service.retire({ ...access, objectKey: value.lease.objectKey });
    assert.deepEqual(value.deleted, [value.lease.objectKey]);
    assert.equal(value.ports.budget.usage(restaurantId, []), 0);
    assert.ok(value.calls.includes("COMMIT"));
    const command: CatalogCommand = { operationId: sessionId, restaurantId, actor, mutation: { type: "restaurant.patch", input: {
      logoUrl: `https://assets.test/${value.lease.objectKey}`,
    } } };
    await assert.rejects(value.service.validateAttachment(command), error => error instanceof AppError && error.statusCode === 410,
      "a delayed writer that acquires the owner lock later must not reattach the retired object");
  } finally { value.sqlite.close(); }
});

test("either retained catalog, including a logo with URL parameters, protects the same underlying R2 key", async () => {
  for (const index of [0, 1]) {
    const value = fixture();
    try {
      value.retained[index]!.catalog.restaurant.logoUrl = `https://assets.test/${value.lease.objectKey}?legacy=1`;
      await assert.rejects(value.service.retire({ ...access, objectKey: value.lease.objectKey }), pending);
      assert.deepEqual(value.deleted, []);
      assert.equal(value.ports.budget.usage(restaurantId, []), 123);
    } finally { value.sqlite.close(); }
  }
});

test("unresolved commands or differing SQL/R2 revisions block cleanup without any R2 deletion", async () => {
  for (const situation of ["pending", "revision"] as const) {
    const value = fixture();
    try {
      if (situation === "pending") value.pending(); else value.revision("13");
      await assert.rejects(value.service.retire({ ...access, objectKey: value.lease.objectKey }), pending);
      assert.deepEqual(value.deleted, []);
      assert.equal(value.ports.budget.get(sessionId)?.state, "staged");
    } finally { value.sqlite.close(); }
  }
});

test("revoked sessions, foreign restaurants and catalog-prefix keys never reach physical storage mutation", async () => {
  for (const situation of ["revoked", "foreign", "prefix"] as const) {
    const value = fixture();
    try {
      if (situation === "revoked") value.revoke(); if (situation === "foreign") value.foreign();
      await assert.rejects(value.service.retire({ ...access, objectKey: situation === "prefix" ? "catalog/v1/preview/manifest.json" : value.lease.objectKey }),
        error => error instanceof AppError && [400, 401, 403].includes(error.statusCode));
      assert.deepEqual(value.deleted, []);
    } finally { value.sqlite.close(); }
  }
});

test("attachment verifies uploaded bytes but still permits external HTTPS logos without touching R2", async () => {
  const value = fixture();
  try {
    const command: CatalogCommand = { operationId: sessionId, restaurantId, actor, mutation: { type: "restaurant.patch", input: {
      logoUrl: `https://assets.test/${value.lease.objectKey}`,
    } } };
    await value.service.validateAttachment(command);
    assert.equal(value.ports.budget.get(sessionId)?.state, "uploaded");
    value.ports.bucket.head = async () => { throw new Error("External logo must not read R2"); };
    await value.service.validateAttachment({ ...command, mutation: { type: "restaurant.patch", input: { logoUrl: "https://external.test/logo.png" } } });
    await assert.rejects(value.service.validateAttachment({ ...command, mutation: { type: "restaurant.patch", input: {
      logoUrl: `https://assets.test/${itemId}/${itemId}/${itemId}`,
    } } }), error => error instanceof AppError && error.statusCode === 403);
  } finally { value.sqlite.close(); }
});
