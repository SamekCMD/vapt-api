import type { Database, Queryable } from "../../lib/database.js";
import type { CommittedChange, CommittedChangePublisher } from "./contracts.js";

export type CommittedChangeOptions = { publishCommittedChange?: CommittedChangePublisher };
export function requireManagedObserverPool(database: Queryable, options: CommittedChangeOptions): Database | undefined {
  if (!options.publishCommittedChange) return undefined;
  if (!("connect" in database) || typeof database.connect !== "function" || "release" in database) {
    throw new Error("Post-commit observer requires a managed database pool");
  }
  return database as Database;
}
export async function emitCommittedChange(options: CommittedChangeOptions, change: CommittedChange | undefined): Promise<void> {
  if (!change || !options.publishCommittedChange) return;
  // The mutation is already committed; invalidation is best-effort, not its result.
  try { await options.publishCommittedChange(change); } catch {}
}
