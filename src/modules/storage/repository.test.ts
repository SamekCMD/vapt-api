import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { createMenuItemExists } from "./repository.js";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const itemId = "20000000-0000-4000-8000-000000000002";
const userId = "30000000-0000-4000-8000-000000000003";

function createQueryable(
  query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ exists: boolean }> }>,
): Queryable {
  return { query } as unknown as Queryable;
}

test("menu item lookup scopes the item to its restaurant and owner", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const exists = await createMenuItemExists(createQueryable(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ exists: true }] };
  }))({ restaurantId, itemId, userId });

  assert.equal(exists, true);
  assert.deepEqual(calls[0]?.values, [itemId, restaurantId, userId]);
  assert.match(calls[0]?.sql ?? "", /join public\.restaurants/i);
  assert.match(calls[0]?.sql ?? "", /restaurant\.owner_id\s*=\s*\$3::uuid/i);
});

test("menu item lookup rejects an item from another restaurant or owner", async () => {
  const exists = await createMenuItemExists(createQueryable(async () => ({
    rows: [{ exists: false }],
  })))({ restaurantId, itemId, userId });

  assert.equal(exists, false);
});

test("menu item lookup keeps PostgreSQL details out of the public error", async () => {
  const lookup = createMenuItemExists(createQueryable(async () => {
    throw new Error("postgresql://owner:secret@db select menu_items");
  }));

  await assert.rejects(
    lookup({ restaurantId, itemId, userId }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "internal_error");
      assert.equal(error.message, "Failed to verify menu item");
      assert.equal(error.diagnostics, undefined);
      assert.doesNotMatch(error.message, /secret|select|menu_items/i);
      return true;
    },
  );
});
