import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { AuthRuntime } from "../modules/auth/runtime.js";
import { runProbeOperation, type ProbeOperationDependencies } from "./hyperdrive-probe-operations.js";
import type { ProbeBindings } from "./hyperdrive-probe.js";

const preview: ProbeBindings = {
  ENVIRONMENT: "preview",
  PROBE_TOKEN: "synthetic-probe-secret-at-least-32-characters",
  HYPERDRIVE: { connectionString: "postgresql://synthetic:synthetic@db.vapt.test/vapt" },
};

test("uses bound parameters for the fixed query", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("current_database()")) {
        return { rows: [{ database: "vapt", username: "vapt_api_preview" }] };
      }
      return { rows: [{ marker: "vapt-stage10" }] };
    },
  } as unknown as Pool;

  const response = await runProbeOperation("query", database, preview);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, parameterized: true });
  const parameterized = calls.find((call) => call.sql.includes("$1"));
  assert.ok(parameterized);
  assert.doesNotMatch(parameterized.sql, /vapt-stage10/);
  assert.deepEqual(parameterized.values, ["vapt-stage10"]);
});

test("identity reports only the expected preview database and role", async () => {
  const database = {
    async query() {
      return { rows: [{ database: "vapt", username: "vapt_api_preview" }] };
    },
  } as unknown as Pool;

  const response = await runProbeOperation("identity", database, preview);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, database: "vapt", user: "vapt_api_preview",
  });
});

test("identity rejects a wrong database without exposing it", async () => {
  const database = {
    async query() {
      return { rows: [{ database: "wrong_database", username: "vapt_api_preview" }] };
    },
  } as unknown as Pool;

  const response = await runProbeOperation("identity", database, preview);

  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /wrong_database/);
});

for (const operation of ["transaction", "auth/create", "auth/revoke", "reconcile"]) {
  for (const identity of [
    { database: "wrong_database", username: "vapt_api_preview" },
    { database: "vapt", username: "wrong_role" },
  ]) {
    test(`${operation} rejects wrong preview identity before writes: ${identity.database}/${identity.username}`, async () => {
      let writes = 0;
      const database = {
        async query(sql: string) {
          if (sql.includes("current_database()")) return { rows: [identity] };
          writes += 1;
          throw new Error("Unexpected SQL after failed identity");
        },
        async connect() {
          writes += 1;
          throw new Error("Unexpected connection after failed identity");
        },
      } as unknown as Pool;
      const response = await runProbeOperation(operation, database, preview, {
        createReconciliationServices() {
          writes += 1;
          throw new Error("Unexpected reconciliation after failed identity");
        },
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false });
      assert.equal(writes, 0);
    });
  }
}

function transactionalDatabase() {
  let persisted = new Map<string, string>();
  let pending: Map<string, string> | null = null;
  const calls: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("current_database()")) {
      return { rows: [{ database: "vapt", username: "vapt_api_preview" }], rowCount: 1 };
    }
    if (sql === "BEGIN") {
      pending = new Map(persisted);
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      assert.ok(pending);
      persisted = pending;
      pending = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      pending = null;
      return { rows: [], rowCount: 0 };
    }
    const rows = pending ?? persisted;
    if (sql.startsWith('INSERT INTO better_auth."verification"')) {
      assert.equal(typeof values[0], "string");
      assert.equal(typeof values[1], "string");
      rows.set(values[0] as string, values[1] as string);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT count(*)::integer AS count FROM better_auth."verification"')) {
      return { rows: [{ count: rows.has(values[0] as string) ? 1 : 0 }], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM better_auth."verification"')) {
      const removed = rows.delete(values[0] as string);
      return { rows: [], rowCount: removed ? 1 : 0 };
    }
    throw new Error(`Unexpected SQL in transaction probe: ${sql}`);
  };
  const database = {
    query,
    async connect() { return { query, release() {} }; },
  } as unknown as Pool;
  return { database, calls, persistedCount: () => persisted.size };
}

test("rollback leaves no row", async () => {
  const fixture = transactionalDatabase();

  const response = await runProbeOperation("transaction", fixture.database, preview);

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.rollbackAbsent, true);
  assert.ok(fixture.calls.includes("ROLLBACK"));
  assert.equal(fixture.persistedCount(), 0);
});

test("commit is visible then cleaned", async () => {
  const fixture = transactionalDatabase();

  const response = await runProbeOperation("transaction", fixture.database, preview);

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.committedVisible, true);
  assert.equal(body.cleaned, true);
  assert.ok(fixture.calls.includes("COMMIT"));
  assert.equal(fixture.persistedCount(), 0);
});

function authFixture() {
  const state: { userId: string | null; email: string | null; token: string | null } = {
    userId: null, email: null, token: null,
  };
  let runtimeCreations = 0;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("current_database()")) {
      return { rows: [{ database: "vapt", username: "vapt_api_preview" }], rowCount: 1 };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO better_auth."user"')) {
      state.userId = "00000000-0000-4000-8000-000000000010";
      assert.equal(values[0], "Vapt Stage 10 Diagnostic");
      state.email = values[1] as string;
      return { rows: [{ id: state.userId }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO better_auth."session"')) {
      assert.equal(values[1], state.userId);
      state.token = values[0] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM better_auth."session"')) {
      assert.equal(values[0], state.token);
      state.token = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM better_auth."user"')) {
      assert.equal(values[0], state.email);
      state.userId = null;
      state.email = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected auth SQL: ${sql}`);
  };
  const database = {
    query,
    async connect() { return { query, release() {} }; },
  } as unknown as Pool;
  const dependencies: ProbeOperationDependencies = {
    createAuthRuntime() {
      runtimeCreations += 1;
      const runtime: AuthRuntime = {
        async handler() { throw new Error("Auth handler is not part of probe"); },
        async getSession(headers) {
          const cookie = headers.get("cookie") ?? "";
          if (!state.token || !state.userId || !state.email ||
            !cookie.startsWith("__Secure-better-auth.session_token=") ||
            !cookie.includes(encodeURIComponent(state.token))) return null;
          return {
            user: { id: state.userId, email: state.email, name: "Vapt Stage 10 Diagnostic" },
            session: { id: "00000000-0000-4000-8000-000000000011", userId: state.userId, expiresAt: new Date(Date.now() + 60000) },
          };
        },
        async close() {},
      };
      return runtime;
    },
  };
  return { database, dependencies, state, runtimeCreations: () => runtimeCreations };
}

test("session survives a fresh auth runtime without exposing its token", async () => {
  const fixture = authFixture();

  const created = await runProbeOperation("auth/create", fixture.database, preview, fixture.dependencies);
  const read = await runProbeOperation("auth/read", fixture.database, preview, fixture.dependencies);

  assert.equal(created.status, 200);
  assert.deepEqual(await read.json(), { ok: true, sessionPresent: true });
  assert.equal(fixture.runtimeCreations(), 1);
  assert.ok(fixture.state.token);
  assert.doesNotMatch(await created.text(), new RegExp(fixture.state.token));
});

test("revoked session is absent in another fresh auth runtime", async () => {
  const fixture = authFixture();

  await runProbeOperation("auth/create", fixture.database, preview, fixture.dependencies);
  const before = await runProbeOperation("auth/read", fixture.database, preview, fixture.dependencies);
  const revoked = await runProbeOperation("auth/revoke", fixture.database, preview, fixture.dependencies);
  const read = await runProbeOperation("auth/read", fixture.database, preview, fixture.dependencies);

  assert.deepEqual(await before.json(), { ok: true, sessionPresent: true });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await read.json(), { ok: true, sessionPresent: false });
  assert.equal(fixture.runtimeCreations(), 2);
  assert.equal(fixture.state.userId, null);
  assert.equal(fixture.state.token, null);
});

test("refuses nonempty eligible outbox before constructing reconciliation", async () => {
  let serviceCreations = 0;
  const query = async (sql: string) => {
    if (sql.includes("current_database()")) return { rows: [{ database: "vapt", username: "vapt_api_preview" }] };
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
    assert.match(sql, /count_pending_payment_effects/);
    return { rows: [{ count: 1 }] };
  };
  const database = {
    query,
    async connect() { return { query, release() {} }; },
  } as unknown as Pool;

  const response = await runProbeOperation("reconcile", database, preview, {
    createReconciliationServices() {
      serviceCreations += 1;
      throw new Error("No provider service should be constructed");
    },
  } as unknown as ProbeOperationDependencies);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, blocked: true });
  assert.equal(serviceCreations, 0);
});

test("runs one bounded reconciliation without starting an interval or provider", async () => {
  const calls = { runOnce: 0, start: 0, provider: 0, limit: 0 };
  const query = async (sql: string) => {
    if (sql.includes("current_database()")) return { rows: [{ database: "vapt", username: "vapt_api_preview" }] };
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    assert.match(sql, /count_pending_payment_effects/);
    return { rows: [{ count: 0 }] };
  };
  const database = {
    query,
    async connect() { return { query, release() {} }; },
  } as unknown as Pool;

  const response = await runProbeOperation("reconcile", database, preview, {
    createReconciliationServices() {
      return {
        config: { paymentEffects: { batchSize: 250 } },
        payments: {
          reconciliation: {
            async runOnce(limit: number) {
              calls.runOnce += 1;
              calls.limit = limit;
              return { claimed: 0, completed: 0, failed: 0, deadLettered: 0, pending: 0 };
            },
            start() { calls.start += 1; },
          },
          registry: { get() { calls.provider += 1; throw new Error("Provider forbidden"); } },
        },
      };
    },
  } as unknown as ProbeOperationDependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ranOnce: true, claimed: 0, pending: 0 });
  assert.deepEqual(calls, { runOnce: 1, start: 0, provider: 0, limit: 100 });
});

test("rolls back reconciliation if work becomes eligible after the empty check", async () => {
  let committedSideEffect = false;
  let pendingSideEffect = false;
  const calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    if (sql.includes("current_database()")) return { rows: [{ database: "vapt", username: "vapt_api_preview" }] };
    if (sql === "BEGIN") return { rows: [] };
    if (sql === "COMMIT") { committedSideEffect = pendingSideEffect; return { rows: [] }; }
    if (sql === "ROLLBACK") { pendingSideEffect = false; return { rows: [] }; }
    if (sql.includes("count_pending_payment_effects")) return { rows: [{ count: 0 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const database = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;

  const response = await runProbeOperation("reconcile", database, preview, {
    createReconciliationServices() {
      return {
        config: { paymentEffects: { batchSize: 1 } },
        payments: { reconciliation: { async runOnce() {
          pendingSideEffect = true;
          return { claimed: 1, completed: 1, failed: 0, deadLettered: 0, pending: 0 };
        } } },
      };
    },
  } as unknown as ProbeOperationDependencies);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, blocked: true });
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(committedSideEffect, false);
  assert.equal(pendingSideEffect, false);
});
