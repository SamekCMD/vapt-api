import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TicketStore } from "./ticket-store.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const admission = { environment: "preview", origin: "https://app.vapt.test", grant: {
  mode: "order", restaurantId, orderId: "22222222-2222-4222-8222-222222222222", tokenFingerprint: "a".repeat(64),
} } as const;

async function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: (string | number | null)[]) {
    const statement = database.prepare(query);
    const rows = statement.all(...bindings);
    return { toArray: () => rows };
  } };
  const transaction = <T>(callback: () => T): T => {
    database.exec("BEGIN");
    try { const result = callback(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  return { store: new TicketStore(sql, transaction), reconstruct: () => new TicketStore(sql, transaction), database };
}

test("tickets carry 256 random bits, expire in 30 seconds, and only hashes are stored", async () => {
  const { store, database } = await fixture();
  try {
    const issued = await store.issue(admission, 1000);
    assert.equal(issued.expiresAt, 31_000);
    assert.equal(issued.restaurantId, restaurantId);
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
    const rows = database.prepare("select * from realtime_tickets").all();
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes(issued.ticket), false);
    assert.match(String(rows[0].hash), /^[0-9a-f]{64}$/);
    assert.equal(await store.consume(issued.ticket, 31_000), null);
    assert.equal(store.count(31_000), 0);
  } finally { database.close(); }
});

test("concurrent consumption admits exactly once and storage survives reconstruction", async () => {
  const { store, reconstruct, database } = await fixture();
  try {
    const issued = await store.issue(admission, 1000);
    const restored = reconstruct();
    const outcomes = await Promise.all([store.consume(issued.ticket, 1001), restored.consume(issued.ticket, 1001)]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.deepEqual(outcomes.find(Boolean), { admission, expiresAt: 31_000 });
    assert.equal(store.count(1001), 0);
    assert.equal(await store.consume("bad", 1001), null);
  } finally { database.close(); }
});

test("ticket capacity is 256, expired slots are reclaimed and next expiry is exact", async () => {
  const { store, database } = await fixture();
  try {
    for (let index = 0; index < 256; index++) await store.issue(admission, 1000);
    assert.equal(store.count(1000), 256);
    assert.equal(store.nextExpiry(1000), 31_000);
    await assert.rejects(store.issue(admission, 1000), /capacity/i);
    assert.equal(store.nextExpiry(31_000), null);
    await store.issue(admission, 31_000);
    assert.equal(store.count(31_000), 1);
    assert.deepEqual(store.orderScopes(31_000), [admission.grant.orderId]);
  } finally { database.close(); }
});
