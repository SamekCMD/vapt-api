import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import pg from "pg";

import { allocateOnboardingRestaurantId } from "./policy.js";
import { applyCatalogCommand } from "./transaction.js";
import { requireLocalCatalogTestUrl } from "./transaction-test-support.js";
import type { CatalogCommand } from "./contracts.js";

test("real PostgreSQL journal, rollback, concurrent retries and revoked-session recovery", { timeout: 60_000 }, async () => {
  const connectionString = requireLocalCatalogTestUrl(process.env.CATALOG_TEST_DATABASE_URL);
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000,
    statement_timeout: 5000, application_name: "vapt-catalog-local-integration" });
  pool.on("error", () => { /* no driver payloads or credentials in test logs */ });
  const userId = randomUUID();
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const restaurantId = await allocateOnboardingRestaurantId(userId, operationId);
  const failedOperation = randomUUID();
  const constraint = `catalog_test_fail_${failedOperation.replaceAll("-", "")}`;
  let constraintCreated = false;
  try {
    const identity = await pool.query<{ name: string }>("select current_database() as name");
    assert.match(identity.rows[0]!.name, /^vapt_catalog_test_[a-z0-9_]+$/);
    const schemaRoot = resolve(process.env.CATALOG_SCHEMA_ROOT ?? "../../infra/neon");
    const baseline = await pool.query<{ present: string | null }>("select to_regclass('public.restaurants')::text as present");
    if (!baseline.rows[0]!.present) {
      const empty = await pool.query<{ count: string }>(`select count(*)::text as count from pg_catalog.pg_tables
        where schemaname not in ('pg_catalog', 'information_schema')`);
      assert.equal(empty.rows[0]!.count, "0", "Initial schema bootstrap requires an empty isolated database");
      for (const file of ["001_business_schema.sql", "003_better_auth_schema.sql", "004_business_constraints.sql"]) {
        await pool.query(await readFile(resolve(schemaRoot, file), "utf8"));
      }
    }
    const journal = await pool.query<{ present: string | null }>("select to_regclass('public.catalog_publication_operations')::text as present");
    if (!journal.rows[0]!.present) await pool.query(await readFile(resolve(schemaRoot, "009_public_catalog_publication.sql"), "utf8"));

    await pool.query(`insert into better_auth."user" (id, name, email, "emailVerified")
      values ($1, 'Catalog Test', $2, true)`, [userId, `catalog-${userId}@example.invalid`]);
    await pool.query(`insert into better_auth."session" (id, "userId", token, "expiresAt", "updatedAt")
      values ($1, $2, $3, now() + interval '1 hour', now())`, [sessionId, userId, randomUUID()]);
    const command: CatalogCommand = { operationId, restaurantId,
      actor: { userId, sessionId, sessionExpiresAt: Date.now() + 3_600_000 }, mutation: { type: "onboarding",
        input: { restaurantName: "Catalog Test", slug: `catalog-${userId}`, dishName: "Prato Teste", dishPrice: "12.00" } } };
    const outcomes = await Promise.all([1, 2, 3].map(() => applyCatalogCommand(pool, command)));
    assert.deepEqual(outcomes[1], outcomes[0]); assert.deepEqual(outcomes[2], outcomes[0]);
    assert.equal((await pool.query("select count(*)::int as n from public.restaurants where owner_id = $1", [userId])).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int as n from public.menu_items where restaurant_id = $1", [restaurantId])).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where actor_id = $1", [userId])).rows[0].n, 1);

    // A real PG constraint failure after domain mutation must roll that mutation back.
    await pool.query(`alter table public.catalog_publication_operations add constraint ${constraint}
      check (operation_id <> '${failedOperation}'::uuid) not valid`);
    constraintCreated = true;
    await assert.rejects(applyCatalogCommand(pool, { ...command, operationId: failedOperation,
      mutation: { type: "restaurant.patch", input: { name: "Must Roll Back" } } }));
    assert.equal((await pool.query("select name from public.restaurants where id = $1", [restaurantId])).rows[0].name, "Catalog Test");
    await pool.query(`alter table public.catalog_publication_operations drop constraint ${constraint}`);
    constraintCreated = false;

    await pool.query('delete from better_auth."session" where id = $1', [sessionId]);
    assert.deepEqual(await applyCatalogCommand(pool, command), outcomes[0], "already committed work remains recoverable");
    await assert.rejects(applyCatalogCommand(pool, { ...command, operationId: randomUUID(),
      mutation: { type: "restaurant.patch", input: { name: "Revoked" } } }),
    (error: unknown) => error instanceof Error && error.message === "Unauthorized");
  } finally {
    // Only objects/rows created by this exact fixture, inside its isolated database.
    if (constraintCreated) await pool.query(`alter table public.catalog_publication_operations drop constraint ${constraint}`);
    await pool.query("delete from public.catalog_publication_operations where actor_id = $1", [userId]).catch(() => undefined);
    await pool.query("delete from public.restaurants where owner_id = $1", [userId]).catch(() => undefined);
    await pool.query('delete from better_auth."user" where id = $1', [userId]).catch(() => undefined);
    await pool.end();
  }
});
