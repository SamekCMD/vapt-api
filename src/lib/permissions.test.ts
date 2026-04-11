import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.js";
import { createSupabaseOwnershipLookup } from "./permissions.js";

test("supabase ownership lookup returns true when restaurant belongs to user", async () => {
  const lookup = createSupabaseOwnershipLookup({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "rest-1" }, error: null }),
          }),
        }),
      }),
    }),
  });

  const allowed = await lookup({ userId: "user-1", restaurantId: "rest-1" });

  assert.equal(allowed, true);
});

test("supabase ownership lookup returns false when restaurant is not owned by user", async () => {
  const lookup = createSupabaseOwnershipLookup({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  });

  const allowed = await lookup({ userId: "user-2", restaurantId: "rest-1" });

  assert.equal(allowed, false);
});

test("supabase ownership lookup throws when verification query fails", async () => {
  const lookup = createSupabaseOwnershipLookup({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { message: "boom" },
            }),
          }),
        }),
      }),
    }),
  });

  await assert.rejects(
    () => lookup({ userId: "user-1", restaurantId: "rest-1" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 500 &&
      error.code === "internal_error",
  );
});
