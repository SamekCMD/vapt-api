import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient } from "pg";

import { withTransaction } from "./database.js";
import type { Database } from "./database.js";

function fakeDatabase(events: string[]): Database {
  const client = {
    async query(sql: string) {
      events.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {
      events.push("release");
    },
  } as unknown as PoolClient;

  return {
    async connect() {
      events.push("connect");
      return client;
    },
    async query() {
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Database;
}

test("withTransaction commits and releases the client", async () => {
  const events: string[] = [];

  const result = await withTransaction(fakeDatabase(events), async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(events, ["connect", "BEGIN", "COMMIT", "release"]);
});

test("withTransaction rolls back and releases after failure", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => withTransaction(fakeDatabase(events), async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.deepEqual(events, ["connect", "BEGIN", "ROLLBACK", "release"]);
});
