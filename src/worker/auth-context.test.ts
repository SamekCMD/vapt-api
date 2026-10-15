import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, PostgresDialect, sql, type PostgresPoolClient } from "kysely";
import { createWorkerAuthContext } from "./auth-context.js";
import { deferred, syntheticAuthDependencies } from "./auth-context-test-support.js";

const denied = { code: "auth_context_unavailable" };

test("concurrent Kysely transactions query, rollback and release only their owning client", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: bridge.dependencies.pool }) });
  const barrier = deferred<void>();
  const a = syntheticAuthDependencies("a", events);
  const b = syntheticAuthDependencies("b", events);
  const first = bridge.run(a, () => db.transaction().execute(async tx => {
    assert.equal((await sql<{ owner: string }>`select 'a'`.execute(tx)).rows[0].owner, "a");
    barrier.resolve();
    await Promise.resolve();
    throw new Error("synthetic transaction failure");
  }));
  const second = bridge.run(b, () => db.transaction().execute(async tx => {
    await barrier.promise;
    assert.equal((await sql<{ owner: string }>`select 'b'`.execute(tx)).rows[0].owner, "b");
  }));
  await assert.rejects(first, /synthetic transaction failure/);
  await second;
  assert.deepEqual(events.filter(x => x.startsWith("a:")), ["a:connect", "a:begin", "a:select 'a'", "a:rollback", "a:release"]);
  assert.deepEqual(events.filter(x => x.startsWith("b:")), ["b:connect", "b:begin", "b:select 'b'", "b:commit", "b:release"]);
  await db.destroy();
  assert.ok(!events.some(x => x.endsWith(":end")));
});

test("email and background promises remain on the live invocation runner", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  const a = syntheticAuthDependencies("a", events);
  const b = syntheticAuthDependencies("b", events);
  await Promise.all([a, b].map(dep => bridge.run(dep, async () => {
    await Promise.resolve();
    bridge.dependencies.runInBackground(bridge.dependencies.emailService.sendPasswordReset({ to: "test@vapt.test", resetPasswordUrl: "https://vapt.test/reset" }));
  })));
  assert.deepEqual(events.sort(), ["a:reset", "b:reset"]);
  assert.equal(a.tasks.length, 1);
  assert.equal(b.tasks.length, 1);
  await Promise.all([...a.tasks, ...b.tasks]);
});

test("missing, expired and wrong contexts fail before SQL or email I/O", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  const a = syntheticAuthDependencies("a", events);
  const b = syntheticAuthDependencies("b", events);
  await assert.rejects(bridge.dependencies.pool.connect(), denied);
  await assert.rejects(bridge.dependencies.emailService.sendPasswordReset({ to: "test", resetPasswordUrl: "test" }), denied);
  assert.throws(() => bridge.dependencies.runInBackground(Promise.resolve()), denied);
  let captured!: PostgresPoolClient;
  let late!: Promise<void>;
  const resume = deferred<void>();
  await bridge.run(a, async () => {
    captured = await bridge.dependencies.pool.connect();
    late = resume.promise.then(async () => {
      await assert.rejects(bridge.dependencies.pool.connect(), denied);
      await assert.rejects(captured.query("late", []), denied);
      await assert.rejects(bridge.dependencies.emailService.sendVerification({ to: "test", confirmationCode: "test", confirmationUrl: "test" }), denied);
      assert.throws(() => bridge.dependencies.runInBackground(Promise.resolve()), denied);
    });
  });
  await bridge.run(b, async () => { await assert.rejects(captured.query("wrong-owner", []), denied); });
  resume.resolve();
  await late;
  captured.release();
  captured.release();
  assert.deepEqual(events, ["a:connect", "a:release"]);
});

test("release is idempotent and queries after release or cursor queries are rejected", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  await bridge.run(syntheticAuthDependencies("a", events), async () => {
    const client = await bridge.dependencies.pool.connect();
    assert.throws(() => client.query({ read: async () => [], close: async () => undefined }), denied);
    client.release();
    client.release();
    await assert.rejects(client.query("released", []), denied);
    await bridge.dependencies.pool.end();
  });
  assert.deepEqual(events, ["a:connect", "a:release"]);
});

test("checkout completing after scope close releases the captured client and rejects", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  const dep = syntheticAuthDependencies("a", events);
  const connect = deferred<PostgresPoolClient>();
  dep.pool.connect = () => connect.promise;
  let pending!: Promise<PostgresPoolClient>;
  await bridge.run(dep, async () => { pending = bridge.dependencies.pool.connect(); });
  const rejection = assert.rejects(pending, denied);
  connect.resolve({ query: async () => { throw new Error("unexpected SQL"); }, release() { events.push("a:release"); } } as unknown as PostgresPoolClient);
  await rejection;
  assert.deepEqual(events, ["a:release"]);
});

test("failed checkout does not poison a later invocation", async () => {
  const bridge = createWorkerAuthContext();
  const events: string[] = [];
  const failed = syntheticAuthDependencies("failed", events);
  failed.pool.connect = async () => { throw new Error("synthetic checkout failure"); };
  await assert.rejects(bridge.run(failed, () => bridge.dependencies.pool.connect()), /checkout failure/);
  await bridge.run(syntheticAuthDependencies("healthy", events), async () => {
    const client = await bridge.dependencies.pool.connect();
    await client.query("select healthy", []);
    client.release();
  });
  assert.deepEqual(events, ["healthy:connect", "healthy:select healthy", "healthy:release"]);
});
