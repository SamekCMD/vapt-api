import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { CatalogCommand } from "../../modules/catalog-publication/contracts.js";
import type { CommittedCommand } from "../../modules/catalog-publication/transaction.js";
import { SqliteCommandStore } from "./command-store.js";
import { createCatalogCoordinator, type CatalogCoordinatorPorts } from "./runner.js";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const initialTime = 1_800_000_000_000;
const command: CatalogCommand = { operationId, restaurantId, actor: { userId,
  sessionId: "44444444-4444-4444-8444-444444444444", sessionExpiresAt: initialTime + 100_000 },
  mutation: { type: "restaurant.patch", input: { name: "Bistrô", cnpj: "synthetic-private" } } };
const committed: CommittedCommand = { receipt: { operationId, restaurantId, phase: "committed", version: "11", committed: true, retryable: true },
  previousSlug: "bistro", result: { cnpj: "synthetic-private" }, state: { version: "11", catalog: { restaurant: {
    id: restaurantId, name: "Bistrô", slug: "bistro", whatsapp: null, address: null, phone: null, hours: null,
    description: null, primaryColor: "#123456", secondaryColor: "#654321", fontFamily: "modern", logoUrl: null,
    totalTables: 1, maxTables: 1, paymentMode: "open_tab", maxPendingOrders: 3, localEnabled: true,
    deliveryEnabled: true, updatedAt: "2026-10-15T00:00:00.000Z" }, items: [] } } };

function fixture() {
  const database = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...values: SQLInputValue[]) {
    const statement = database.prepare(query);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const store = new SqliteCommandStore(sql);
  let now = initialTime;
  let alarm: number | null = null;
  let failTransaction = false;
  let failCommitAt: number | undefined;
  let failSyncAt: number | undefined;
  let transactions = 0;
  let committedSql: CommittedCommand | null = null;
  let failureStage: "apply" | "project" | "signal" | undefined;
  let failed = false;
  let alwaysFailApply = false;
  let applies = 0; let writes = 0; let lookups = 0; let signals = 0; let projections = 0;
  const ports: CatalogCoordinatorPorts = {
    store, now: () => now,
    storage: {
      async transaction(work) {
        const oldAlarm = alarm; database.exec("BEGIN");
        try { const result = await work(); transactions++;
          if (failTransaction || transactions === failCommitAt) throw new Error("synthetic local storage unavailable");
          database.exec("COMMIT"); return result;
        } catch (error) { database.exec("ROLLBACK"); alarm = oldAlarm; throw error; }
      },
      async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = null; },
      async sync() { if (transactions === failSyncAt) throw new Error("synthetic storage acknowledgement lost"); },
    },
    async apply() {
      applies++;
      assert.ok(store.intent(operationId), "durable intent exists before SQL");
      assert.ok(alarm !== null, "durable recovery alarm exists before SQL");
      if (alwaysFailApply) throw new Error("synthetic SQL unavailable");
      if (!committedSql) { committedSql = committed; writes++; }
      if (failureStage === "apply" && !failed) { failed = true; throw new Error("synthetic response lost after SQL commit"); }
      return committedSql;
    },
    async findCommitted() { lookups++; return committedSql; },
    async project(value) {
      projections++;
      assert.equal(store.get(operationId)?.phase, "committed");
      if (failureStage === "project" && !failed) { failed = true; throw new Error("synthetic R2 response lost"); }
      return value.state;
    },
    async signal() {
      signals++;
      assert.equal(store.get(operationId)?.phase, "ready", "ready is durably checkpointed before signaling");
      assert.equal(store.get(operationId)?.work, "signal", "signal intent remains durable until delivery attempt completes");
      if (failureStage === "signal" && !failed) { failed = true; throw new Error("synthetic signal interruption"); }
    },
    async prune() { return {}; },
  };
  return { database, store, ports, counts: () => ({ applies, writes, lookups, signals, projections }),
    alarm: () => alarm, advance: () => { now = alarm ?? now + 5000; }, setNow: (value: number) => { now = value; },
    failStorage: () => { failTransaction = true; }, failCommitAt: (number: number) => { failCommitAt = number; },
    failSyncAt: (number: number) => { failSyncAt = number; },
    failAt: (stage: typeof failureStage) => { failureStage = stage; },
    failSql: () => { alwaysFailApply = true; } };
}

test("persistBeforeApply storage+alarm failure never starts a domain mutation", async () => {
  const value = fixture();
  try {
    value.failStorage();
    await assert.rejects(createCatalogCoordinator(value.ports).submit(command));
    assert.equal(value.counts().writes, 0);
    assert.equal(value.store.get(operationId), null);
    assert.equal(value.alarm(), null);
  } finally { value.database.close(); }
});

test("successful publication erases private intent/result and preserves only the dedup receipt", async () => {
  const value = fixture();
  try {
    const runner = createCatalogCoordinator(value.ports);
    const result = await runner.submit(command);
    assert.equal(result.receipt.phase, "ready");
    assert.equal(value.counts().writes, 1); assert.equal(value.counts().signals, 1);
    assert.equal(value.store.intent(operationId), null);
    assert.deepEqual(value.database.prepare("select payload from catalog_command_chunks").all(), []);
    const receipt = await runner.status({ operationId, restaurantId, actor: command.actor });
    assert.equal(receipt.phase, "ready"); assert.equal("result" in receipt, false);
  } finally { value.database.close(); }
});

for (const stage of ["apply", "project", "signal"] as const) {
  test(`crashAtEveryBoundary recovers ${stage} interruption without duplicate domain effects`, async () => {
    const value = fixture();
    try {
      value.failAt(stage);
      const first = await createCatalogCoordinator(value.ports).submit(command);
      if (stage !== "signal") assert.notEqual(first.receipt.phase, "ready");
      assert.notEqual(value.store.get(operationId)?.work, "none");
      value.advance();
      const restored = createCatalogCoordinator(value.ports);
      await restored.alarm();
      assert.equal((await restored.status({ operationId, restaurantId, actor: command.actor })).phase, "ready");
      assert.equal(value.counts().writes, 1);
      if (stage === "apply") assert.equal(value.counts().applies, 1, "ambiguous SQL resolved by journal lookup first");
      assert.equal(value.store.intent(operationId), null);
    } finally { value.database.close(); }
  });
}

test("blockedAfterTen never keeps retrying SQL, but private-expiry alarm still erases intent", async () => {
  const value = fixture();
  try {
    value.failSql(); const runner = createCatalogCoordinator(value.ports);
    await runner.submit(command);
    for (let attempt = 1; attempt < 10; attempt++) { value.advance(); await runner.alarm(); }
    assert.equal(value.counts().applies, 10);
    assert.equal(value.store.get(operationId)?.phase, "blocked");
    assert.equal(value.alarm(), initialTime + 86_400_000);
    value.advance(); await runner.alarm();
    assert.equal(value.store.intent(operationId), null);
    assert.equal(value.counts().applies, 10);
    assert.equal(value.alarm(), initialTime + 604_800_000);
  } finally { value.database.close(); }
});

test("emptyHasNoSqlAlarm constructor and expiry of an empty room do not initialize database work", async () => {
  const value = fixture();
  try {
    await createCatalogCoordinator(value.ports).alarm();
    assert.deepEqual(value.counts(), { applies: 0, writes: 0, lookups: 0, signals: 0, projections: 0 });
    assert.equal(value.alarm(), null);
  } finally { value.database.close(); }
});

test("manual signal retry restores the projected phase, never SQL or the private command", async () => {
  const value = fixture();
  try {
    const signal = value.ports.signal;
    value.ports.signal = async () => { throw new Error("synthetic signal unavailable"); };
    const runner = createCatalogCoordinator(value.ports);
    await runner.submit(command);
    for (let attempt = 1; attempt < 10; attempt++) { value.advance(); await runner.alarm(); }
    assert.equal(value.store.get(operationId)?.phase, "blocked");
    assert.equal(value.store.intent(operationId), null);
    value.ports.signal = signal;
    assert.equal((await runner.retry({ operationId, restaurantId, actor: command.actor })).phase, "ready");
    assert.equal(value.counts().applies, 1);
  } finally { value.database.close(); }
});

test("retry after renewing a session uses the newly authenticated actor for unapplied SQL", async () => {
  const value = fixture();
  try {
    const apply = value.ports.apply;
    value.ports.apply = async () => { throw new Error("synthetic unavailable before SQL"); };
    const runner = createCatalogCoordinator(value.ports);
    await runner.submit(command);
    const freshActor = { ...command.actor, sessionId: restaurantId, sessionExpiresAt: initialTime + 500_000 };
    value.ports.apply = async input => { assert.equal(input.actor.sessionId, freshActor.sessionId); return apply(input); };
    assert.equal((await runner.retry({ operationId, restaurantId, actor: freshActor })).phase, "ready");
    assert.equal(value.counts().writes, 1);
  } finally { value.database.close(); }
});

test("an expired unknown outcome may recover an existing journal result without resurrecting an intent", async () => {
  const value = fixture();
  try {
    value.failAt("apply");
    const runner = createCatalogCoordinator(value.ports);
    await runner.submit(command);
    value.setNow(initialTime + 86_400_001);
    await runner.alarm();
    assert.equal(value.store.intent(operationId), null);
    assert.equal((await runner.retry({ operationId, restaurantId, actor: command.actor })).phase, "ready");
    assert.equal(value.counts().applies, 1);
  } finally { value.database.close(); }
});

for (const boundary of [3, 5, 7, 8, 10]) {
  test(`a failed durable checkpoint ${boundary} recovers without repeating the committed SQL effect`, async () => {
    const value = fixture();
    try {
      value.failCommitAt(boundary);
      const runner = createCatalogCoordinator(value.ports);
      await runner.submit(command);
      assert.notEqual(value.store.get(operationId)?.work, "none");
      value.advance();
      const restored = createCatalogCoordinator(value.ports);
      await restored.alarm();
      assert.equal(value.store.get(operationId)?.phase, "ready");
      assert.equal(value.store.get(operationId)?.work, "none");
      assert.equal(value.counts().writes, 1);
      assert.equal(value.counts().applies, 1);
    } finally { value.database.close(); }
  });
}

test("committed pending publication retains only public projection chunks, not CNPJ or session", async () => {
  const value = fixture();
  try {
    value.failAt("project");
    await createCatalogCoordinator(value.ports).submit(command);
    const chunks = value.database.prepare("select payload from catalog_command_chunks").all();
    assert.ok(chunks.length > 0);
    assert.equal(JSON.stringify(chunks).includes("synthetic-private"), false);
    assert.equal(JSON.stringify(chunks).includes(command.actor.sessionId), false);
    assert.equal(value.store.intent(operationId), null);
  } finally { value.database.close(); }
});

for (const boundary of [3, 5, 8]) {
  test(`an ambiguous storage acknowledgement at checkpoint ${boundary} never regresses a committed phase`, async () => {
    const value = fixture();
    try {
      value.failSyncAt(boundary);
      await createCatalogCoordinator(value.ports).submit(command);
      const expectedWork = boundary === 3 ? "project" : boundary === 5 ? "signal" : "cleanup";
      assert.equal(value.store.get(operationId)?.work, expectedWork, "do not overwrite a newer checkpoint after a lost acknowledgement");
      value.advance();
      await createCatalogCoordinator(value.ports).alarm();
      assert.equal(value.store.get(operationId)?.phase, "ready");
      assert.equal(value.counts().writes, 1);
      assert.equal(value.counts().applies, 1);
    } finally { value.database.close(); }
  });
}

test("a restarted invocation at the tenth consumed attempt parks work without an eleventh SQL call", async () => {
  const value = fixture();
  try {
    const operation = value.store.accept(command, "a".repeat(64), initialTime);
    value.store.save({ ...operation, attempts: 10, nextAt: initialTime });
    await createCatalogCoordinator(value.ports).alarm();
    assert.equal(value.counts().applies, 0);
    assert.equal(value.store.get(operationId)?.phase, "blocked");
  } finally { value.database.close(); }
});
