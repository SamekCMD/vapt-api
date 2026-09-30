import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "hono";
import { Pool } from "pg";

import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { createWorkerDatabase } from "./database.js";
import { createWorkerServices } from "./services.js";

const context = { waitUntil() {} } as unknown as ExecutionContext;
const preview = {
  ENVIRONMENT: "preview" as const,
  HYPERDRIVE: { connectionString: "postgresql://synthetic:private-sentinel@db.vapt.test/vapt" },
};

test("rejects missing Hyperdrive without secret echo", () => {
  assert.throws(
    () => createWorkerDatabase({ HYPERDRIVE: undefined }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HYPERDRIVE/);
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    },
  );
});

test("creates distinct max-one pools", async () => {
  const first = createWorkerDatabase(preview);
  const second = createWorkerDatabase(preview);
  try {
    assert.notStrictEqual(first, second);
    assert.equal(first.options.max, 1);
    assert.equal(second.options.max, 1);
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
});

test("bounds diagnostic checkout, statement, read and lock waits", async () => {
  const pool = createWorkerDatabase(preview, { diagnostic: true });
  try {
    const statementTimeout = Number(pool.options.statement_timeout ?? 0);
    assert.ok((pool.options.connectionTimeoutMillis ?? 0) > 0);
    assert.ok(statementTimeout > 0);
    assert.ok((pool.options.query_timeout ?? 0) > statementTimeout);
    assert.ok(Number(pool.options.lock_timeout ?? 0) > 0);
    assert.ok(Number(pool.options.lock_timeout ?? 0) < statementTimeout);
  } finally {
    await pool.end();
  }
});

test("service composition uses a max-one pool", async () => {
  const services = await createWorkerServices(preview, context, { config: {} as AppConfig });
  assert.ok(services.database instanceof Pool);
  const pool = services.database as Pool;
  try {
    assert.equal(pool.options.max, 1);
  } finally {
    await pool.end();
  }
});

test("honors injected database", async () => {
  const injected = {
    async query() { return { rows: [] }; },
    async connect() { throw new Error("not used"); },
  } as unknown as Database;
  const services = await createWorkerServices({ ENVIRONMENT: "preview" }, context, {
    config: {} as AppConfig,
    database: injected,
  });
  assert.strictEqual(services.database, injected);
});
