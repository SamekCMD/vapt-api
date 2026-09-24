import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../lib/errors.js";
import { createSupabaseMenuItemExists } from "./repository.js";

test("menu item lookup scopes the item to its restaurant", async () => {
  const calls: unknown[] = [];
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      return {
        select(columns: string) {
          calls.push(["select", columns]);
          return {
            eq(column: string, value: string) {
              calls.push(["eq", column, value]);
              return {
                eq(nextColumn: string, nextValue: string) {
                  calls.push(["eq", nextColumn, nextValue]);
                  return {
                    async maybeSingle() {
                      return { data: { id: "item-1" }, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const exists = await createSupabaseMenuItemExists(client as never)({
    restaurantId: "restaurant-1",
    itemId: "item-1",
  });

  assert.equal(exists, true);
  assert.deepEqual(calls, [
    ["from", "menu_items"],
    ["select", "id"],
    ["eq", "id", "item-1"],
    ["eq", "restaurant_id", "restaurant-1"],
  ]);
});

test("menu item lookup keeps storage diagnostics out of the public error message", async () => {
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return { data: null, error: { message: "private upstream details" } };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    createSupabaseMenuItemExists(client as never)({
      restaurantId: "restaurant-1",
      itemId: "item-1",
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "internal_error" &&
      error.message === "Failed to verify menu item" &&
      error.diagnostics?.storage === "private upstream details",
  );
});
