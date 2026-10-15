import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import { SqliteImageBudget, type ImageReservationInput } from "./image-budget.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const now = 1_800_000_000_000;
const input: ImageReservationInput = { leaseId, restaurantId, itemId, contentType: "image/webp", bytes: 5_242_880, now, ttlMs: 300_000 };
function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    const statement = database.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  return { database, sql, budget: new SqliteImageBudget(sql) };
}
const quotaError = (error: unknown) => error instanceof AppError && error.statusCode === 413 && error.code === "menu_image_quota_exceeded";

// Removing durable reservations, double-counting uploaded bytes, or refunding expired
// URLs would all break these observable admission/usage assertions.
test("50 MiB includes retained images and pending uploads; the exact boundary is admitted", () => {
  const { database, budget } = fixture();
  try {
    const inventory = [{ key: `${restaurantId}/old-item/old-image`, size: 47_185_920 }];
    const reservation = budget.reserve(input, inventory);
    assert.match(reservation.objectKey, new RegExp(`^${restaurantId}/${itemId}/[a-f0-9-]{36}$`));
    assert.equal(budget.usage(restaurantId, inventory), 52_428_800);
    assert.throws(() => budget.reserve({ ...input, leaseId: "44444444-4444-4444-8444-444444444444", bytes: 1 }, inventory), quotaError);
  } finally { database.close(); }
});

test("successful uploads are counted once, but a smaller object does not refund its unresolved reservation", () => {
  const { database, budget } = fixture();
  try {
    const reservation = budget.reserve(input, []);
    assert.equal(budget.usage(restaurantId, [{ key: reservation.objectKey, size: 5_242_880 }]), 5_242_880);
    assert.equal(budget.usage(restaurantId, [{ key: reservation.objectKey, size: 36 }]), 5_242_880);
    assert.equal(budget.usage(restaurantId, [{ key: reservation.objectKey, size: 5_242_881 }]), 5_242_881);
  } finally { database.close(); }
});

test("restart and URL expiry do not release potentially in-flight upload bytes", () => {
  const { database, sql, budget } = fixture();
  try {
    budget.reserve(input, [{ key: `${restaurantId}/legacy`, size: 47_185_920 }]);
    const restarted = new SqliteImageBudget(sql);
    assert.equal(restarted.get(leaseId)?.expiresAt, now + 300_000);
    assert.throws(() => restarted.reserve({ ...input, leaseId: "44444444-4444-4444-8444-444444444444", bytes: 1,
      now: now + 86_400_000 }, [{ key: `${restaurantId}/legacy`, size: 47_185_920 }]), quotaError);
  } finally { database.close(); }
});

test("idempotent reservation replay cannot change target, size or type", () => {
  const { database, budget } = fixture();
  try {
    const original = budget.reserve(input, []);
    assert.deepEqual(budget.reserve({ ...input, now: now + 1000 }, []), original);
    for (const patch of [{ itemId: leaseId }, { bytes: 123 }, { contentType: "image/png" as const }]) {
      assert.throws(() => budget.reserve({ ...input, ...patch }, []), error => error instanceof AppError && error.statusCode === 409);
    }
  } finally { database.close(); }
});

test("at most ten pending uploads survive admission, independent of tiny requested sizes", () => {
  const { database, budget } = fixture();
  try {
    for (let index = 1; index <= 10; index++) budget.reserve({ ...input, bytes: 1,
      leaseId: `${String(index).padStart(8, "0")}-3333-4333-8333-333333333333` }, []);
    assert.equal(budget.usage(restaurantId, []), 360, "staging fence bytes are reserved too");
    assert.throws(() => budget.reserve({ ...input, bytes: 1 }, []), error => error instanceof AppError && error.statusCode === 429);
  } finally { database.close(); }
});

test("invalid or cross-restaurant inventories fail closed instead of undercounting storage", () => {
  const { database, budget } = fixture();
  try {
    for (const inventory of [
      [{ key: `${itemId}/foreign`, size: 1 }], [{ key: `${restaurantId}/bad`, size: -1 }],
      [{ key: `${restaurantId}/bad`, size: Number.NaN }],
      [{ key: `${restaurantId}/duplicate`, size: 1 }, { key: `${restaurantId}/duplicate`, size: 1 }],
    ]) assert.throws(() => budget.reserve(input, inventory), error => error instanceof AppError && error.statusCode === 503);
    assert.equal(budget.get(leaseId), null);
    budget.reserve(input, []);
    assert.throws(() => budget.reserve({ ...input, restaurantId: itemId }, []), error => error instanceof AppError && error.statusCode === 409);
  } finally { database.close(); }
});

test("invalid byte sizes and non-image types cannot bypass the 5 MiB per-file limit", () => {
  const { database, budget } = fixture();
  try {
    for (const bytes of [0, -1, 1.5, 5_242_881, Number.NaN, Infinity]) {
      assert.throws(() => budget.reserve({ ...input, bytes }, []), error => error instanceof AppError && error.statusCode === 400);
    }
    assert.throws(() => budget.reserve({ ...input, contentType: "text/html" } as never, []), error => error instanceof AppError && error.statusCode === 400);
    assert.equal(budget.get(leaseId), null);
  } finally { database.close(); }
});

test("a complete thousand-object inventory cannot admit a 1001st object even below the byte quota", () => {
  const { database, budget } = fixture();
  try {
    const inventory = Array.from({ length: 1000 }, (_, index) => ({ key: `${restaurantId}/old-${index}`, size: 1 }));
    assert.throws(() => budget.reserve(input, inventory), error => error instanceof AppError && error.statusCode === 429);
    assert.equal(budget.get(leaseId), null);
  } finally { database.close(); }
});

test("unlisted pending PUTs still occupy slots in the thousand-object inventory budget", () => {
  const { database, budget } = fixture();
  try {
    const inventory = Array.from({ length: 999 }, (_, index) => ({ key: `${restaurantId}/old-${index}`, size: 1 }));
    budget.reserve({ ...input, bytes: 1 }, inventory);
    assert.throws(() => budget.reserve({ ...input, bytes: 1, leaseId: "44444444-4444-4444-8444-444444444444" }, inventory),
      error => error instanceof AppError && error.statusCode === 429);
  } finally { database.close(); }
});

test("safe retired metadata ages out after the seven-day replay window without refunding uncertain fences", () => {
  const { database, budget } = fixture();
  try {
    for (let index = 1; index <= 1000; index++) {
      const id = `${String(index).padStart(8, "0")}-3333-4333-8333-333333333333`;
      budget.reserve({ ...input, leaseId: id, bytes: 1 }, []);
      budget.retired(id, 0, now);
    }
    assert.throws(() => budget.reserve(input, []), error => error instanceof AppError && error.statusCode === 429);
    budget.reserve({ ...input, now: now + 604_800_000 }, []);
    assert.equal(budget.get("00000001-3333-4333-8333-333333333333"), null);
    assert.equal(budget.usage(restaurantId, [{ key: `${restaurantId}/uncertain-retired-marker`, size: 36 }]), 5_242_916);
  } finally { database.close(); }
});
