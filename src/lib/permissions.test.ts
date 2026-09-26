import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "./database.js";
import { AppError } from "./errors.js";
import { createOwnershipLookup } from "./permissions.js";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";

function createQueryable(
  query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ allowed: boolean }> }>,
): Queryable {
  return { query } as unknown as Queryable;
}

test("PostgreSQL ownership lookup returns the database decision with tenant parameters", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const lookup = createOwnershipLookup(createQueryable(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ allowed: true }] };
  }));

  const allowed = await lookup({ userId, restaurantId });

  assert.equal(allowed, true);
  assert.deepEqual(calls[0]?.values, [restaurantId, userId]);
  assert.match(calls[0]?.sql ?? "", /from public\.restaurants/i);
  assert.match(calls[0]?.sql ?? "", /owner_id\s*=\s*\$2::uuid/i);
});

test("PostgreSQL ownership lookup returns false for another owner", async () => {
  const lookup = createOwnershipLookup(createQueryable(async () => ({
    rows: [{ allowed: false }],
  })));

  const allowed = await lookup({
    userId: "30000000-0000-4000-8000-000000000003",
    restaurantId,
  });

  assert.equal(allowed, false);
});

test("ownership lookup rejects an invalid UUID before querying PostgreSQL", async () => {
  let queried = false;
  const lookup = createOwnershipLookup(createQueryable(async () => {
    queried = true;
    return { rows: [{ allowed: false }] };
  }));

  await assert.rejects(
    () => lookup({ userId, restaurantId: "not-a-uuid" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 400 &&
      error.code === "invalid_request",
  );
  assert.equal(queried, false);
});

test("ownership lookup sanitizes PostgreSQL errors", async () => {
  const lookup = createOwnershipLookup(createQueryable(async () => {
    throw new Error("postgresql://user:secret@db/private select owner_id");
  }));

  await assert.rejects(
    () => lookup({ userId, restaurantId }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, "internal_error");
      assert.equal(error.message, "Failed to verify restaurant access");
      assert.equal(error.diagnostics, undefined);
      assert.doesNotMatch(error.message, /secret|select|owner_id/i);
      return true;
    },
  );
});
