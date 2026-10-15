import type { SqlStorage } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import type { CatalogActor, CatalogCommand, CommandReceipt } from "../../modules/catalog-publication/contracts.js";
import type { CommittedCommand } from "../../modules/catalog-publication/transaction.js";

export type CatalogWork = "apply" | "project" | "signal" | "cleanup" | "none";
export type StoredOperation = CommandReceipt & {
  userId: string; fingerprint: string; createdAt: number; expiresAt: number; privateExpiresAt: number;
  work: CatalogWork; attempts: number; nextAt: number | null; intentPresent: boolean; projectionPresent: boolean;
  resumeWork?: CatalogWork; cleanupCursor?: string; signalVersion?: string;
  checkpoint: number;
};

export class SqliteCommandStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`create table if not exists catalog_commands (
      operation_id text primary key, metadata text not null, pending integer not null,
      next_at integer, private_expires_at integer, expires_at integer not null, created_at integer not null)`);
    sql.exec(`create table if not exists catalog_command_chunks (
      operation_id text not null, kind text not null, ordinal integer not null, payload text not null,
      primary key (operation_id, kind, ordinal))`);
    sql.exec("create table if not exists catalog_room_scope (singleton integer primary key check(singleton = 1), restaurant_id text not null)");
    sql.exec("create index if not exists catalog_command_due on catalog_commands(next_at)");
    sql.exec("create index if not exists catalog_command_expiry on catalog_commands(expires_at)");
    sql.exec("create index if not exists catalog_command_unready on catalog_commands(json_extract(metadata, '$.phase'))");
  }

  // Mutators are called inside one ctx.storage.transaction with alarm updates.
  // No storage cursor is retained across an await.
  accept(command: CatalogCommand, fingerprint: string, now: number): StoredOperation {
    const scope = this.sql.exec<{ restaurant_id: string }>("select restaurant_id from catalog_room_scope where singleton = 1").toArray()[0];
    if (scope && scope.restaurant_id !== command.restaurantId) throw new AppError(409, "catalog_room_conflict", "Catalog room does not match restaurant");
    const existing = this.get(command.operationId);
    if (existing && existing.expiresAt > now) {
      if (existing.userId !== command.actor.userId || existing.restaurantId !== command.restaurantId || existing.fingerprint !== fingerprint) {
        throw new AppError(409, "catalog_operation_conflict", "Catalog operation conflicts with existing work");
      }
      return existing;
    }
    const count = this.sql.exec<{ total: number }>("select count(*) as total from catalog_commands where pending = 1").toArray()[0]!.total;
    if (count >= 100) throw new AppError(429, "catalog_queue_full", "Catalog publication queue is full");
    if (!scope) this.sql.exec("insert into catalog_room_scope(singleton, restaurant_id) values(1, ?)", command.restaurantId);
    if (existing) this.sql.exec("delete from catalog_command_chunks where operation_id = ?", command.operationId);
    const operation: StoredOperation = { operationId: command.operationId, restaurantId: command.restaurantId,
      userId: command.actor.userId, fingerprint, phase: "accepted", committed: false, version: null, retryable: true,
      createdAt: now, expiresAt: now + 604_800_000, privateExpiresAt: now + 86_400_000,
      work: "apply", attempts: 0, nextAt: now, intentPresent: true, projectionPresent: false, checkpoint: 0 };
    this.writeBody(command.operationId, "intent", command);
    return this.save(operation);
  }

  get(operationId: string): StoredOperation | null {
    const row = this.sql.exec<{ metadata: string }>("select metadata from catalog_commands where operation_id = ?", operationId).toArray()[0];
    return row ? JSON.parse(row.metadata) as StoredOperation : null;
  }

  hasUnresolved(): boolean {
    return this.sql.exec("select operation_id from catalog_commands where json_extract(metadata, '$.phase') in ('accepted', 'committed', 'projected', 'blocked') limit 1").toArray().length > 0;
  }

  intent(operationId: string): CatalogCommand | null { return this.readBody(operationId, "intent"); }

  refreshActor(operationId: string, actor: CatalogActor): void {
    const command = this.intent(operationId);
    if (!command || command.actor.userId !== actor.userId) {
      throw new AppError(409, "catalog_operation_conflict", "Catalog operation conflicts with existing work");
    }
    this.writeBody(operationId, "intent", { ...command, actor });
  }

  projection(operationId: string): CommittedCommand | null {
    const value = this.readBody<Omit<CommittedCommand, "result">>(operationId, "projection");
    return value ? { ...value, result: null } : null;
  }

  saveProjection(operationId: string, value: CommittedCommand): void {
    // Private/admin result is invocation-local only, never part of the persisted public projection.
    this.writeBody(operationId, "projection", { receipt: value.receipt, state: value.state, previousSlug: value.previousSlug });
  }

  eraseIntent(operationId: string): void {
    this.sql.exec("delete from catalog_command_chunks where operation_id = ? and kind = 'intent'", operationId);
  }

  eraseProjection(operationId: string): void {
    this.sql.exec("delete from catalog_command_chunks where operation_id = ? and kind = 'projection'", operationId);
  }

  save(input: StoredOperation): StoredOperation {
    const operation = { ...input, checkpoint: (this.get(input.operationId)?.checkpoint ?? 0) + 1 };
    const pending = operation.work !== "none" || (operation.phase === "blocked" && (operation.intentPresent || operation.projectionPresent));
    this.sql.exec(`insert into catalog_commands(operation_id, metadata, pending, next_at, private_expires_at, expires_at, created_at)
      values (?, ?, ?, ?, ?, ?, ?) on conflict(operation_id) do update set
      metadata = excluded.metadata, pending = excluded.pending, next_at = excluded.next_at,
      private_expires_at = excluded.private_expires_at, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    operation.operationId, JSON.stringify(operation), Number(pending), operation.nextAt,
    operation.intentPresent ? operation.privateExpiresAt : null, operation.expiresAt, operation.createdAt);
    return operation;
  }

  due(now: number): StoredOperation | null {
    const row = this.sql.exec<{ metadata: string }>(`select metadata from catalog_commands
      where next_at is not null and next_at <= ? order by created_at, operation_id limit 1`, now).toArray()[0];
    return row ? JSON.parse(row.metadata) as StoredOperation : null;
  }

  nextAlarm(): number | null {
    return this.sql.exec<{ at: number | null }>(`select min(value) as at from (
      select min(next_at) as value from catalog_commands union all
      select min(private_expires_at) as value from catalog_commands union all
      select min(expires_at) as value from catalog_commands)`).toArray()[0]!.at;
  }

  expire(now: number): void {
    const rows = this.sql.exec<{ metadata: string }>(`select metadata from catalog_commands
      where expires_at <= ? or private_expires_at <= ? limit 100`, now, now).toArray();
    for (const row of rows) {
      const operation = JSON.parse(row.metadata) as StoredOperation;
      if (operation.expiresAt <= now) {
        this.sql.exec("delete from catalog_command_chunks where operation_id = ?", operation.operationId);
        this.sql.exec("delete from catalog_commands where operation_id = ?", operation.operationId);
      } else {
        this.sql.exec("delete from catalog_command_chunks where operation_id = ? and kind = 'intent'", operation.operationId);
        operation.intentPresent = false;
        if (!operation.committed) {
          operation.phase = "blocked"; operation.resumeWork = "apply"; operation.work = "none";
          operation.nextAt = null; operation.retryable = false;
        }
        this.save(operation);
      }
    }
  }

  private writeBody(operationId: string, kind: string, value: unknown): void {
    const text = JSON.stringify(value);
    this.sql.exec("delete from catalog_command_chunks where operation_id = ? and kind = ?", operationId, kind);
    let ordinal = 0;
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 262_144);
      // Do not split a surrogate pair: SQLite encodes each TEXT binding separately.
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      this.sql.exec("insert into catalog_command_chunks(operation_id, kind, ordinal, payload) values(?, ?, ?, ?)",
        operationId, kind, ordinal++, text.slice(offset, end));
      offset = end;
    }
  }

  private readBody<T>(operationId: string, kind: string): T | null {
    const rows = this.sql.exec<{ payload: string }>(`select payload from catalog_command_chunks
      where operation_id = ? and kind = ? order by ordinal`, operationId, kind).toArray();
    return rows.length ? JSON.parse(rows.map(row => row.payload).join("")) as T : null;
  }
}
