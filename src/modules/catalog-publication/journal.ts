import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { compareVersion, type CommandIdentity } from "./contracts.js";
import type { CommittedCommand } from "./transaction.js";

type JournalRow = {
  operation_id: string; actor_id: string; restaurant_id: string; fingerprint: string; version: string;
  snapshot: CommittedCommand["state"]; result: unknown; previous_slug: string | null;
};

export function commandConflict(): AppError {
  return new AppError(409, "catalog_operation_conflict", "Catalog operation conflicts with existing work");
}

export async function readJournal(client: Queryable, identity: CommandIdentity): Promise<CommittedCommand | null> {
  const found = await client.query<JournalRow>(`select operation_id, actor_id, restaurant_id, fingerprint,
    version::text, snapshot, result, previous_slug from public.catalog_publication_operations
    where operation_id = $1::uuid and expires_at > clock_timestamp()`, [identity.operationId]);
  const row = found.rows[0];
  if (!row) return null;
  if (row.actor_id !== identity.actor.userId || row.restaurant_id !== identity.restaurantId
    || row.fingerprint !== identity.fingerprint) throw commandConflict();
  if (compareVersion(row.version, row.snapshot.version) !== 0
    || row.snapshot.catalog.restaurant.id !== row.restaurant_id) {
    throw new AppError(503, "catalog_journal_invalid", "Catalog publication unavailable");
  }
  return {
    receipt: { operationId: row.operation_id, restaurantId: row.restaurant_id, phase: "committed",
      committed: true, retryable: true, version: row.version },
    result: row.result, state: row.snapshot, previousSlug: row.previous_slug,
  };
}

export async function writeJournal(client: Queryable, identity: CommandIdentity, outcome: CommittedCommand): Promise<void> {
  await client.query(`insert into public.catalog_publication_operations
    (operation_id, actor_id, restaurant_id, fingerprint, version, snapshot, result, previous_slug)
    values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::bigint, $6::jsonb, $7::jsonb, $8::text)`,
  [identity.operationId, identity.actor.userId, identity.restaurantId, identity.fingerprint,
    outcome.state.version, JSON.stringify(outcome.state), JSON.stringify(outcome.result), outcome.previousSlug]);
}
