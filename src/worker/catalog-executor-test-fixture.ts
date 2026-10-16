// Local workerd entry ONLY. Simulates the external PostgreSQL journal in R2;
// proves real SQLite/alarm recovery, never PostgreSQL transaction semantics.
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import type { CatalogCommand, CatalogState } from "../modules/catalog-publication/contracts.js";
import type { CommittedCommand } from "../modules/catalog-publication/transaction.js";
import { SqliteCommandStore } from "./catalog/command-store.js";
import { createCatalogCoordinator } from "./catalog/runner.js";
import { createCatalogProjection } from "./catalog/projection.js";

type TestCase = { command: CatalogCommand; state: CatalogState; fault: "accepted" | "committed" | "projection" | "signal" };
type Env = { R2_BUCKET: R2Bucket };
const now = 1_800_000_000_000;

export class CatalogExecutionProbe extends DurableObject<Env> {
  private readonly commands: SqliteCommandStore;
  private readonly runner: ReturnType<typeof createCatalogCoordinator>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); this.commands = new SqliteCommandStore(ctx.storage.sql);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS catalog_execution_test (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.increment("constructors");
    const bucket = env.R2_BUCKET;
    const projection = createCatalogProjection({
      get: bucket.get.bind(bucket), list: bucket.list.bind(bucket),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await bucket.put(...args);
        // Lose a response after the second real R2 PUT: snapshot/manifest exist,
        // mapping may not. Retrying must complete the original revision.
        this.increment("projectionPuts");
        if (this.number("projectionPuts") === 2) this.fault("projection");
        return result;
      },
    }, "preview");
    this.runner = createCatalogCoordinator({
      store: this.commands, now: () => now,
      storage: { transaction: work => ctx.storage.transaction(async () => work()),
        setAlarm: at => ctx.storage.setAlarm(at), deleteAlarm: () => ctx.storage.deleteAlarm(), sync: () => ctx.storage.sync() },
      apply: async command => {
        this.increment("applies");
        if (!this.commands.intent(command.operationId) || await ctx.storage.getAlarm() === null) throw new Error("Intent/alarm not durable before simulated external SQL");
        this.fault("accepted");
        const value = this.testCase();
        const committed: CommittedCommand = { receipt: { operationId: command.operationId, restaurantId: command.restaurantId,
          phase: "committed", version: value.state.version, committed: true, retryable: true }, state: value.state, previousSlug: null, result: { cnpj: "synthetic-private" } };
        const key = this.journalKey(command.operationId);
        const saved = await bucket.get(key);
        if (saved) return saved.json<CommittedCommand>();
        await bucket.put(key, JSON.stringify(committed)); this.increment("writes");
        this.fault("committed"); return committed;
      },
      findCommitted: async identity => {
        this.increment("lookups"); const value = await bucket.get(this.journalKey(identity.operationId));
        return value ? value.json<CommittedCommand>() : null;
      },
      project: value => projection.publish(value),
      signal: async () => {
        if (this.commands.get(this.testCase().command.operationId)?.phase !== "ready") throw new Error("Ready checkpoint missing");
        this.fault("signal"); this.increment("signals");
      },
      prune: (id, cursor) => projection.prune(id, cursor),
    });
  }
  private text(key: string): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM catalog_execution_test WHERE key = ?", key).toArray()[0]?.value ?? null;
  }
  private put(key: string, value: string) { this.ctx.storage.sql.exec("INSERT INTO catalog_execution_test VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value); }
  private number(key: string) { return Number(this.text(key) ?? 0); }
  private increment(key: string) { this.put(key, String(this.number(key) + 1)); }
  private testCase(): TestCase { return JSON.parse(this.text("case")!); }
  private journalKey(id: string) { return `_local-test-journal/${id}.json`; }
  private fault(stage: TestCase["fault"]) {
    if (this.testCase().fault === stage && !this.number("failed")) { this.put("failed", "1"); throw new Error("Synthetic interrupted boundary"); }
  }
  private access() { const { command } = this.testCase(); return { operationId: command.operationId, restaurantId: command.restaurantId, actor: command.actor }; }
  async begin(value: TestCase) { this.put("case", JSON.stringify(value)); await this.runner.submit(value.command); return this.info(); }
  async retryAfterReaderRollback() {
    // The executor intentionally never consults PUBLIC_CATALOG_READER_ENABLED.
    await this.runner.retry(this.access()); return this.info();
  }
  async idle() { await this.runner.alarm(); return this.info(); }
  async info() {
    return { receipt: await this.runner.status(this.access()), alarm: await this.ctx.storage.getAlarm(),
      constructors: this.number("constructors"), writes: this.number("writes"), applies: this.number("applies"), lookups: this.number("lookups"),
      privateChunks: this.ctx.storage.sql.exec("SELECT operation_id FROM catalog_command_chunks WHERE instr(payload, 'synthetic-private') > 0").toArray().length > 0 };
  }
  alarm() { return this.runner.alarm(); }
}
