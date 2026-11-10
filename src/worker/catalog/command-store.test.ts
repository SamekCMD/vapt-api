import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { CatalogCommand } from "../../modules/catalog-publication/contracts.js";
import { SqliteCommandStore } from "./command-store.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const now = 1_800_000_000_000;
const command: CatalogCommand = { operationId, restaurantId, actor: { userId,
  sessionId: "44444444-4444-4444-8444-444444444444", sessionExpiresAt: now + 100_000 },
  mutation: { type: "restaurant.patch", input: { name: "Bistrô", cnpj: "synthetic-private" } } };

function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    const statement = database.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const store = new SqliteCommandStore(sql);
  return { database, sql, store };
}

test("accepted intent survives reconstruction and duplicate keys cannot change actor or payload", () => {
  const { database, sql, store } = fixture();
  try {
    const accepted = store.accept(command, "a".repeat(64), now);
    assert.equal(accepted.phase, "accepted");
    assert.deepEqual(new SqliteCommandStore(sql).intent(operationId), command);
    assert.deepEqual(store.accept(command, "a".repeat(64), now + 10), accepted);
    assert.throws(() => store.accept(command, "b".repeat(64), now + 10));
    assert.throws(() => store.accept({ ...command, actor: { ...command.actor, userId: restaurantId } }, "a".repeat(64), now));
  } finally { database.close(); }
});

test("the 101st pending intent is refused without losing any accepted work", () => {
  const { database, store } = fixture();
  try {
    for (let index = 1; index <= 100; index++) store.accept({ ...command,
      operationId: `${String(index).padStart(8, "0")}-3333-4333-8333-333333333333` }, "a".repeat(64), now);
    assert.throws(() => store.accept(command, "a".repeat(64), now));
    assert.equal(store.get(operationId), null);
    assert.ok(store.due(now));
  } finally { database.close(); }
});

test("blocked private intents expire after 24h without changing dedup metadata or requiring SQL", () => {
  const { database, store } = fixture();
  try {
    const accepted = store.accept(command, "a".repeat(64), now);
    store.save({ ...accepted, phase: "blocked", work: "none", nextAt: null });
    store.expire(now + 86_400_000);
    assert.equal(store.intent(operationId), null);
    assert.equal(store.get(operationId)?.fingerprint, "a".repeat(64));
    assert.equal(store.due(now + 86_400_000), null);
    assert.equal(store.nextAlarm(), now + 604_800_000, "only local metadata expiry remains");
    const rows = database.prepare("select payload from catalog_command_chunks").all();
    assert.deepEqual(rows, []);
  } finally { database.close(); }
});

test("metadata expires at seven days and leaves no periodic alarm work", () => {
  const { database, store } = fixture();
  try {
    store.accept(command, "a".repeat(64), now);
    store.expire(now + 604_800_000);
    assert.equal(store.get(operationId), null);
    assert.equal(store.nextAlarm(), null);
    assert.equal(store.due(now + 604_800_000), null);
  } finally { database.close(); }
});

test("cleanup admission sees blocked unresolved commands but not already-ready cleanup work", () => {
  const { database, store } = fixture();
  try {
    assert.equal(store.hasUnresolved(), false);
    const accepted = store.accept(command, "a".repeat(64), now);
    assert.equal(store.hasUnresolved(), true);
    store.save({ ...accepted, phase: "blocked", work: "none", nextAt: null, intentPresent: false });
    assert.equal(store.hasUnresolved(), true);
    store.save({ ...accepted, phase: "ready", committed: true, work: "cleanup" });
    assert.equal(store.hasUnresolved(), false);
  } finally { database.close(); }
});

test("chunked intents preserve Unicode without an oversized SQLite row", () => {
  const { database, sql, store } = fixture();
  try {
    const payload = { ...command, mutation: { type: "restaurant.patch" as const,
      input: { name: "Bistrô", description: "🍽".repeat(150_000) } } };
    // Storage only: command validation/body limit remains at admission, not this persistence port.
    store.accept(payload, "a".repeat(64), now);
    assert.deepEqual(new SqliteCommandStore(sql).intent(operationId), payload);
    const lengths = database.prepare("select length(cast(payload as blob)) as bytes from catalog_command_chunks").all();
    assert.ok(lengths.length > 1);
    assert.ok(lengths.every(row => Number(row.bytes) <= 786_432));
  } finally { database.close(); }
});
