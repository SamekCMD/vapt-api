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
import { verifyImagePostgresConcurrency } from "../../worker/catalog/image-service.pg-test-support.js";

test("real PostgreSQL catalog transaction guarantees", { timeout: 60_000 }, async t => {
  const connectionString = requireLocalCatalogTestUrl(process.env.CATALOG_TEST_DATABASE_URL);
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000,
    statement_timeout: 5000, application_name: "vapt-catalog-local-integration" });
  pool.on("error", () => { /* no driver payloads or credentials in test logs */ });
  const userId = randomUUID();
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const restaurantId = await allocateOnboardingRestaurantId(userId, operationId);
  const failedOperation = randomUUID();
  const secondUserId = randomUUID();
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
    assert.ok(Buffer.byteLength(JSON.stringify(outcomes[0]!.state), "utf8") <= 8_388_608);
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
    assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [failedOperation])).rows[0].n, 0);
    await pool.query(`alter table public.catalog_publication_operations drop constraint ${constraint}`);
    constraintCreated = false;

    await t.test("concurrent item create/delete retries have one durable effect", async () => {
      const create: CatalogCommand = { ...command, operationId: randomUUID(), mutation: { type: "item.create", input: {
        name: "Segundo Prato", price: "15.00", description: null, category: "Pratos", available: true,
        imageUrl: null, availableFrom: null, availableUntil: null, badge: null,
        isChefSuggestion: false, prepTimeMinutes: null, variations: [],
      } } };
      const created = await Promise.all([1, 2, 3].map(() => applyCatalogCommand(pool, create)));
      assert.deepEqual(created[1], created[0]); assert.deepEqual(created[2], created[0]);
      assert.equal((await pool.query("select count(*)::int as n from public.menu_items where restaurant_id = $1", [restaurantId])).rows[0].n, 2);
      const itemId = (created[0]!.result as { id: string }).id;
      const deletion: CatalogCommand = { ...command, operationId: randomUUID(), mutation: { type: "item.delete", itemId } };
      const deleted = await Promise.all([1, 2, 3].map(() => applyCatalogCommand(pool, deletion)));
      assert.deepEqual(deleted[1], deleted[0]); assert.deepEqual(deleted[2], deleted[0]);
      assert.equal((await pool.query("select count(*)::int as n from public.menu_items where id = $1", [itemId])).rows[0].n, 0);
      assert.equal((await pool.query(`select count(*)::int as n from public.catalog_publication_operations
        where operation_id = any($1::uuid[])`, [[create.operationId, deletion.operationId]])).rows[0].n, 2);
      assert.ok(create.mutation.type === "item.create");
      await assert.rejects(applyCatalogCommand(pool, { ...create, mutation: { ...create.mutation,
        input: { ...create.mutation.input, name: "Conflicting payload" } } }),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409);
    });

    await t.test("UTF8 snapshot over 8 MiB rolls back domain, revision and journal", async () => {
      const before = (await pool.query("select name, description from public.restaurants where id = $1", [restaurantId])).rows[0];
      const version = (await pool.query("select version::text from public.catalog_publication_revisions where restaurant_id = $1", [restaurantId])).rows[0].version;
      const oversizedId = randomUUID();
      // Seed a valid SQL aggregate larger than the HTTP mutation schema; no remote data is used.
      await pool.query("update public.restaurants set description = repeat('é', 4194304) where id = $1", [restaurantId]);
      try {
        await assert.rejects(applyCatalogCommand(pool, { ...command, operationId: oversizedId,
          mutation: { type: "restaurant.patch", input: { name: "Must Not Commit" } } }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "catalog_snapshot_too_large");
        assert.equal((await pool.query("select name from public.restaurants where id = $1", [restaurantId])).rows[0].name, before.name);
        assert.equal((await pool.query("select version::text from public.catalog_publication_revisions where restaurant_id = $1", [restaurantId])).rows[0].version, version);
        assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [oversizedId])).rows[0].n, 0);
      } finally {
        await pool.query("update public.restaurants set description = $2 where id = $1", [restaurantId, before.description]);
      }
    });

    await t.test("concurrent slug claims serialize, and reuse receives a newer global revision", async () => {
      const secondSessionId = randomUUID();
      const secondOp = randomUUID();
      const secondRestaurantId = await allocateOnboardingRestaurantId(secondUserId, secondOp);
      await pool.query(`insert into better_auth."user" (id, name, email, "emailVerified")
        values ($1, 'Other Catalog Test', $2, true)`, [secondUserId, `catalog-${secondUserId}@example.invalid`]);
      await pool.query(`insert into better_auth."session" (id, "userId", token, "expiresAt", "updatedAt")
        values ($1, $2, $3, now() + interval '1 hour', now())`, [secondSessionId, secondUserId, randomUUID()]);
      const other: CatalogCommand = { operationId: secondOp, restaurantId: secondRestaurantId,
        actor: { userId: secondUserId, sessionId: secondSessionId, sessionExpiresAt: Date.now() + 3_600_000 },
        mutation: { type: "onboarding", input: { restaurantName: "Other Catalog Test", slug: `catalog-${secondUserId}`,
          dishName: "Outro Prato", dishPrice: "10.00" } } };
      await applyCatalogCommand(pool, other);
      const slug = `claim-${randomUUID()}`;
      const claims = [command, other].map(base => ({ ...base, operationId: randomUUID(),
        mutation: { type: "restaurant.patch" as const, input: { slug } } }));
      const race = await Promise.allSettled(claims.map(claim => applyCatalogCommand(pool, claim)));
      const winner = race.findIndex(result => result.status === "fulfilled");
      assert.ok(winner === 0 || winner === 1);
      const loser = 1 - winner;
      assert.equal(race[loser]!.status, "rejected");
      const rejected = race[loser] as PromiseRejectedResult;
      assert.equal(rejected.reason.statusCode, 409);
      assert.equal((await pool.query("select count(*)::int as n from public.restaurants where slug = $1", [slug])).rows[0].n, 1);
      const released = await applyCatalogCommand(pool, { ...claims[winner]!, operationId: randomUUID(),
        mutation: { type: "restaurant.patch", input: { slug: `released-${randomUUID()}` } } });
      const reused = await applyCatalogCommand(pool, { ...claims[loser]!, operationId: randomUUID() });
      const won = (race[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof applyCatalogCommand>>>).value;
      assert.ok(BigInt(won.state.version) < BigInt(released.state.version));
      assert.ok(BigInt(released.state.version) < BigInt(reused.state.version));
      assert.equal(reused.state.catalog.restaurant.slug, slug);
      assert.equal((await pool.query("select id from public.restaurants where slug = $1", [slug])).rows[0].id, claims[loser]!.restaurantId);
    });

    await t.test("expired session cannot mutate even when the accepted actor expiry is still future", async () => {
      const expiredId = randomUUID();
      await pool.query('update better_auth."session" set "expiresAt" = now() - interval \'1 second\' where id = $1', [sessionId]);
      try {
        await assert.rejects(applyCatalogCommand(pool, { ...command, operationId: expiredId,
          mutation: { type: "restaurant.patch", input: { name: "Expired Must Not Commit" } } }),
        (error: unknown) => error instanceof Error && error.message === "Unauthorized");
        assert.equal((await pool.query("select name from public.restaurants where id = $1", [restaurantId])).rows[0].name, "Catalog Test");
        assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [expiredId])).rows[0].n, 0);
      } finally {
        await pool.query('update better_auth."session" set "expiresAt" = now() + interval \'1 hour\' where id = $1', [sessionId]);
      }
    });

    await t.test("revocation while waiting on the owner lock prevents a pending mutation", async () => {
      const blocker = await pool.connect();
      const pendingId = randomUUID();
      let pending: Promise<Awaited<ReturnType<typeof applyCatalogCommand>>> | undefined;
      try {
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`catalog:owner:${userId}`]);
        pending = applyCatalogCommand(pool, { ...command, operationId: pendingId,
          mutation: { type: "restaurant.patch", input: { name: "Queued Must Not Commit" } } });
        // Attach the rejection observer before releasing the SQL barrier.
        const denied = assert.rejects(pending, (error: unknown) => error instanceof Error && error.message === "Unauthorized");
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = await pool.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity
            where application_name = 'vapt-catalog-local-integration' and wait_event = 'advisory'`);
          if (state.rows[0]!.n > 0) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, "the command must actually wait in PostgreSQL before session revocation");
        await pool.query('delete from better_auth."session" where id = $1', [sessionId]);
        await blocker.query("commit");
        await denied;
        assert.equal((await pool.query("select name from public.restaurants where id = $1", [restaurantId])).rows[0].name, "Catalog Test");
        assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [pendingId])).rows[0].n, 0);
      } finally {
        await blocker.query("rollback");
        blocker.release();
        await pending?.catch(() => undefined);
        await pool.query(`insert into better_auth."session" (id, "userId", token, "expiresAt", "updatedAt")
          values ($1, $2, $3, now() + interval '1 hour', now()) on conflict (id) do nothing`, [sessionId, userId, randomUUID()]);
      }
    });

    await t.test("expired journal cleanup is bounded and an expired operation can apply anew", async () => {
      await pool.query(`insert into public.catalog_publication_operations
        (operation_id, actor_id, restaurant_id, fingerprint, version, snapshot, result, committed_at, expires_at)
        select gen_random_uuid(), $1::uuid, $2::uuid, repeat('a', 64), v,
          $3::jsonb || jsonb_build_object('version', v::text), 'null'::jsonb,
          now() - interval '8 days', now() - interval '1 day'
        from (select nextval('public.catalog_publication_version_seq') as v from generate_series(1, 101)) as fixtures`,
      [userId, restaurantId, JSON.stringify(outcomes[0]!.state)]);
      const patch: CatalogCommand = { ...command, operationId: randomUUID(),
        mutation: { type: "restaurant.patch", input: { name: "Retention Test" } } };
      const first = await applyCatalogCommand(pool, patch);
      assert.equal((await pool.query(`select count(*)::int as n from public.catalog_publication_operations
        where actor_id = $1 and expires_at <= clock_timestamp()`, [userId])).rows[0].n, 1);
      await pool.query(`update public.catalog_publication_operations set committed_at = now() - interval '8 days',
        expires_at = now() - interval '1 day' where operation_id = $1`, [patch.operationId]);
      await pool.query("update public.restaurants set name = 'Intervening Fixture' where id = $1", [restaurantId]);
      const replay = await applyCatalogCommand(pool, patch);
      assert.ok(BigInt(replay.state.version) > BigInt(first.state.version), "expired key is not a permanent dedup tombstone");
      assert.equal((await pool.query("select name from public.restaurants where id = $1", [restaurantId])).rows[0].name, "Retention Test");
      assert.equal((await pool.query("select count(*)::int as n from public.catalog_publication_operations where operation_id = $1", [patch.operationId])).rows[0].n, 1);
    });

    await verifyImagePostgresConcurrency(t, pool, command);

    await pool.query('delete from better_auth."session" where id = $1', [sessionId]);
    assert.deepEqual(await applyCatalogCommand(pool, command), outcomes[0], "already committed work remains recoverable");
    await assert.rejects(applyCatalogCommand(pool, { ...command, operationId: randomUUID(),
      mutation: { type: "restaurant.patch", input: { name: "Revoked" } } }),
    (error: unknown) => error instanceof Error && error.message === "Unauthorized");
  } finally {
    // Only objects/rows created by this exact fixture, inside its isolated database.
    if (constraintCreated) await pool.query(`alter table public.catalog_publication_operations drop constraint ${constraint}`);
    await pool.query("delete from public.catalog_publication_operations where actor_id = any($1::uuid[])", [[userId, secondUserId]]).catch(() => undefined);
    await pool.query("delete from public.restaurants where owner_id = any($1::uuid[])", [[userId, secondUserId]]).catch(() => undefined);
    await pool.query('delete from better_auth."user" where id = any($1::uuid[])', [[userId, secondUserId]]).catch(() => undefined);
    await pool.end();
  }
});
