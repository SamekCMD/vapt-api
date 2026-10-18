// PostgreSQL integration support only; never imported by a Worker entrypoint.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { Pool } from "pg";
import { AppError } from "../../lib/errors.js";
import type { CatalogCommand } from "../../modules/catalog-publication/contracts.js";
import { applyCatalogCommand } from "../../modules/catalog-publication/transaction.js";
import { SqliteImageBudget } from "./image-budget.js";
import { createCatalogImageService, type CatalogImageServicePorts } from "./image-service.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}
async function reached(gate: ReturnType<typeof barrier>, operation: Promise<unknown>) {
  await Promise.race([gate.promise, operation.then(() => assert.fail("operation ended before reaching the controlled I/O barrier"))]);
}
async function sqlWait(pool: Pool) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await pool.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity
      where application_name = 'vapt-catalog-local-integration' and wait_event_type = 'Lock'`);
    if (waiting.rows[0]!.n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("the competing operation must actually wait for a PostgreSQL lock");
}

async function fixture(pool: Pool, base: CatalogCommand) {
  const initial = await applyCatalogCommand(pool, { ...base, operationId: randomUUID(), mutation: { type: "rebuild" } });
  const retained = [initial.state];
  const sqlite = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...values: SQLInputValue[]) {
    const statement = sqlite.prepare(query);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const budget = new SqliteImageBudget(sql);
  const itemId = initial.state.catalog.items[0]!.id;
  const leaseId = randomUUID();
  const lease = budget.reserve({ leaseId, restaurantId: base.restaurantId, itemId,
    contentType: "image/webp", bytes: 123, now: Date.now(), ttlMs: 300_000 }, []);
  budget.stageAttempt(leaseId); budget.staged(leaseId, "staging-etag"); budget.uploaded(leaseId);
  const access = { restaurantId: base.restaurantId, itemId, actor: base.actor, objectKey: lease.objectKey };
  const deleting = barrier(); const finishDelete = barrier();
  let pauseDelete = false; let imagePresent = true; let deletions = 0;
  // Storage/projection are controlled adapters, deliberately not a claim of R2
  // platform proof. PostgreSQL, its lock waits, domain/journal and SQLite are real.
  const ports: CatalogImageServicePorts = {
    database: pool, budget, publicBaseUrl: new URL("https://assets.test/"), now: () => Date.now(), ttlMs: 300_000,
    exclusive: work => work(), // Independent invocations: do NOT hide the SQL race behind a JS queue.
    atomic: async work => work(), hasUnresolvedCommands: () => false,
    projection: { async readRetainedCatalogs() { return retained; } },
    signer: { async createUploadUrl() { throw new Error("No upload URL may be issued by this fixture"); } },
    bucket: {
      async head(key: string) { assert.equal(key, lease.objectKey); return imagePresent ? {
        etag: "uploaded-etag", httpEtag: '"uploaded-etag"', size: 123, httpMetadata: { contentType: "image/webp" },
      } : null; },
      async delete(key: string) {
        assert.equal(key, lease.objectKey); deleting.release();
        if (pauseDelete) await finishDelete.promise;
        imagePresent = false; deletions++;
      },
      async put() { throw new Error("No uncertain staging object in this fixture"); },
      async list() { throw new Error("No upload inventory needed"); },
    } as unknown as CatalogImageServicePorts["bucket"],
  };
  return { sqlite, budget, leaseId, lease, access, retained, ports,
    service: createCatalogImageService(ports), deleting, finishDelete,
    pauseDeletion: () => { pauseDelete = true; },
    present: () => imagePresent, deletions: () => deletions,
    attachment: (): CatalogCommand => ({ ...base, operationId: randomUUID(), mutation: {
      type: "restaurant.patch", input: { logoUrl: `https://assets.test/${lease.objectKey}` },
    } }),
  };
}

export async function verifyImagePostgresConcurrency(t: TestContext, pool: Pool, base: CatalogCommand): Promise<void> {
  for (const method of ["retire", "reconcile"] as const) await t.test(`SQL ${method} holds its lock through storage deletion and a delayed attachment cannot resurrect the image`, async () => {
    const value = await fixture(pool, base);
    value.pauseDeletion();
    if (method === "reconcile") value.ports.now = () => Date.now() + 300_001;
    const retirement = observe<unknown>(method === "retire" ? value.service.retire(value.access)
      : value.service.reconcile({ restaurantId: base.restaurantId, actor: base.actor }));
    const command = value.attachment();
    let applying: ReturnType<typeof observe<Awaited<ReturnType<typeof applyCatalogCommand>>>> | undefined;
    let validations = 0;
    try {
      await reached(value.deleting, retirement);
      applying = observe(applyCatalogCommand(pool, command, { validateImages: async current => {
        validations++; await value.service.validateAttachment(current);
      } }));
      await sqlWait(pool);
      assert.equal(validations, 0, "attachment validation must not run before the competing SQL transaction finishes");
      assert.equal(value.present(), true);
      value.finishDelete.release();
      assert.equal((await retirement).ok, true);
      const result = await applying;
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("a deleted object cannot be attached");
      assert.ok(result.error instanceof AppError && result.error.statusCode === 410);
      assert.equal(validations, 1);
      assert.equal(value.deletions(), 1);
      assert.equal(value.budget.usage(base.restaurantId, []), 0);
      assert.equal((await pool.query("select logo_url from public.restaurants where id = $1", [base.restaurantId])).rows[0].logo_url, null);
      assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [command.operationId])).rows[0].n, 0);
    } finally {
      value.finishDelete.release(); await retirement; await applying; value.sqlite.close();
    }
  });

  await t.test("SQL attachment commits before waiting retirement; revision lag and both retained snapshots protect the object", async () => {
    const value = await fixture(pool, base);
    const validating = barrier(); const finishValidation = barrier();
    const command = value.attachment();
    const applying = observe(applyCatalogCommand(pool, command, { validateImages: async current => {
      validating.release(); await finishValidation.promise; await value.service.validateAttachment(current);
    } }));
    let retirement: ReturnType<typeof observe<void>> | undefined;
    try {
      await reached(validating, applying);
      retirement = observe(value.service.retire(value.access));
      await sqlWait(pool);
      assert.equal(value.deletions(), 0);
      finishValidation.release();
      const attached = await applying;
      if (!attached.ok) throw attached.error;
      assert.equal(attached.value.state.catalog.restaurant.logoUrl, `https://assets.test/${value.lease.objectKey}`);
      const rejected = await retirement;
      assert.equal(rejected.ok, false, "cleanup must re-read SQL revision after waiting, not use stale admission data");
      if (rejected.ok) assert.fail("stale published revision cannot authorize cleanup");
      assert.ok(rejected.error instanceof AppError && rejected.error.code === "menu_image_cleanup_pending");
      assert.equal(value.present(), true);
      value.retained.unshift(attached.value.state);
      await assert.rejects(value.service.retire(value.access), error => error instanceof AppError && error.statusCode === 409);
      const detached = await applyCatalogCommand(pool, { ...base, operationId: randomUUID(), mutation: {
        type: "restaurant.patch", input: { logoUrl: null },
      } });
      value.retained.splice(0, value.retained.length, detached.state, attached.value.state);
      await assert.rejects(value.service.retire(value.access), error => error instanceof AppError && error.statusCode === 409,
        "the previous published snapshot must still protect its image");
      assert.equal(value.deletions(), 0);
      assert.equal(value.budget.usage(base.restaurantId, []), 123);
      const next = await applyCatalogCommand(pool, { ...base, operationId: randomUUID(), mutation: { type: "rebuild" } });
      value.retained.splice(0, value.retained.length, next.state, detached.state);
      await value.service.retire(value.access);
      assert.equal(value.deletions(), 1); assert.equal(value.present(), false);
      assert.equal(value.budget.usage(base.restaurantId, []), 0);
    } finally {
      finishValidation.release(); await applying; await retirement; value.sqlite.close();
    }
  });

  await t.test("session revocation waits for an already authorized retirement to complete its physical deletion", async () => {
    const value = await fixture(pool, base);
    value.pauseDeletion();
    const retirement = observe(value.service.retire(value.access));
    let revocation: ReturnType<typeof observe<unknown>> | undefined;
    try {
      await reached(value.deleting, retirement);
      revocation = observe(pool.query('delete from better_auth."session" where id = $1', [base.actor.sessionId]));
      await sqlWait(pool);
      value.finishDelete.release();
      assert.equal((await retirement).ok, true);
      assert.equal((await revocation).ok, true);
      assert.equal(value.deletions(), 1);
      const denied = value.service.retire(value.access);
      await assert.rejects(denied, error => error instanceof AppError && error.statusCode === 401);
    } finally {
      value.finishDelete.release(); await retirement; await revocation; value.sqlite.close();
      await pool.query(`insert into better_auth."session" (id, "userId", token, "expiresAt", "updatedAt")
        values ($1, $2, $3, now() + interval '1 hour', now()) on conflict (id) do nothing`,
      [base.actor.sessionId, base.actor.userId, randomUUID()]);
    }
  });
}
