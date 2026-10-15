import type { PoolClient } from "pg";
import { withTransaction, type Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { buildPublicCatalog } from "../catalog/repository.js";
import { createMenuRepository } from "../menu/repository.js";
import { createMenuService } from "../menu/service.js";
import { createRestaurantRepository } from "../restaurants/repository.js";
import { createRestaurantService } from "../restaurants/service.js";
import type { CatalogCommand, CatalogState, CommandIdentity, CommandReceipt } from "./contracts.js";
import { commandConflict, readJournal, writeJournal } from "./journal.js";
import { affectsPublicCatalog, allocateOnboardingRestaurantId, fingerprintCommand, validateCatalogCommand } from "./policy.js";

export type CommittedCommand = { receipt: CommandReceipt; result: unknown; state: CatalogState; previousSlug: string | null };

async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
}

async function mutate(database: Database, client: PoolClient, command: CatalogCommand, publicBaseUrl: URL | null): Promise<unknown> {
  const restaurants = createRestaurantService(createRestaurantRepository(database, {
    transaction: client, onboardingRestaurantId: command.restaurantId,
  }));
  const menu = createMenuService(createMenuRepository(database, { transaction: client }), { publicBaseUrl });
  const { mutation, actor } = command;
  switch (mutation.type) {
    case "onboarding": return restaurants.createOwnedRestaurant(actor.userId, mutation.input);
    case "restaurant.patch": return restaurants.updateOwnedRestaurant(actor.userId, mutation.input);
    case "item.create": return menu.createOwnedMenuItem(actor.userId, mutation.input);
    case "item.patch": return menu.updateOwnedMenuItem(actor.userId, mutation.itemId, mutation.input);
    case "item.delete": await menu.deleteOwnedMenuItem(actor.userId, mutation.itemId); return null;
    case "rebuild": return null;
  }
}

export async function applyCatalogCommand(
  database: Database, input: CatalogCommand, options: {
    publicBaseUrl?: URL | null; validateImages?: (command: CatalogCommand) => Promise<void>;
  } = {},
): Promise<CommittedCommand> {
  const command = validateCatalogCommand(input);
  if (command.mutation.type === "restaurant.patch" && !affectsPublicCatalog(command.mutation.input)) {
    throw new AppError(400, "catalog_private_only_patch", "Private-only patches do not publish a catalog");
  }
  if (command.mutation.type === "onboarding"
    && command.restaurantId !== await allocateOnboardingRestaurantId(command.actor.userId, command.operationId)) {
    throw commandConflict();
  }
  const identity: CommandIdentity = { ...command, fingerprint: await fingerprintCommand(command) };
  return withTransaction(database, async client => {
    // Operation key first: different actors cannot race one key into separate effects.
    await lock(client, `catalog:operation:${command.operationId}`);
    const existing = await readJournal(client, identity);
    if (existing) return existing;
    await lock(client, `catalog:owner:${command.actor.userId}`);
    const found = await client.query<{ id: string; slug: string }>(
      "select id, slug from public.restaurants where owner_id = $1::uuid", [command.actor.userId],
    );
    const owned = found.rows[0];
    if (command.mutation.type === "onboarding" ? Boolean(owned) : owned?.id !== command.restaurantId) {
      throw new AppError(409, "catalog_restaurant_conflict", "Restaurant does not match catalog operation");
    }
    const mutation = command.mutation;
    const nextSlug = mutation.type === "onboarding" ? mutation.input.slug
      : mutation.type === "restaurant.patch" && mutation.input.slug ? mutation.input.slug : owned!.slug;
    const slugs = [...new Set([owned?.slug, nextSlug].filter((slug): slug is string => Boolean(slug)))].sort();
    // Do not row-lock a restaurant before acquiring every slug lock: cross-owner renames could deadlock.
    for (const slug of slugs) await lock(client, `catalog:slug:${slug}`);
    if (owned) {
      const current = await client.query<{ id: string; slug: string }>(
        "select id, slug from public.restaurants where id = $1::uuid and owner_id = $2::uuid for update",
        [command.restaurantId, command.actor.userId],
      );
      if (current.rows[0]?.slug !== owned.slug) throw commandConflict();
    }
    const active = await client.query<{ id: string }>(`select id from better_auth."session"
      where id = $1::uuid and "userId" = $2::uuid and "expiresAt" > clock_timestamp() for share`,
    [command.actor.sessionId, command.actor.userId]);
    if (!active.rows[0]) throw new AppError(401, "unauthorized", "Unauthorized");
    const imageUrl = mutation.type === "restaurant.patch" ? mutation.input.logoUrl
      : mutation.type === "item.create" || mutation.type === "item.patch" ? mutation.input.imageUrl : null;
    if (imageUrl) {
      if (!options.validateImages) throw new AppError(503, "catalog_image_validation_required", "Image validation unavailable");
      // Same owner lock as image retirement. A delayed apply MUST verify after
      // acquiring it, never rely on an object check made before waiting on SQL.
      await options.validateImages(command);
    }
    // Idempotency has a seven-day logical window; expired keys are not permanent tombstones.
    await client.query(`delete from public.catalog_publication_operations
      where operation_id = $1::uuid and expires_at <= clock_timestamp()`, [command.operationId]);
    await client.query(`delete from public.catalog_publication_operations where operation_id in
      (select operation_id from public.catalog_publication_operations where expires_at <= clock_timestamp()
      order by expires_at limit 100)`);
    const result = await mutate(database, client, command, options.publicBaseUrl ?? null);
    const allocated = await client.query<{ version: string }>(
      "select nextval('public.catalog_publication_version_seq')::text as version",
    );
    const version = allocated.rows[0]!.version;
    const state: CatalogState = { version, catalog: await buildPublicCatalog(client, command.restaurantId) };
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 8_388_608) {
      throw new AppError(413, "catalog_snapshot_too_large", "Public catalog exceeds publication size limit");
    }
    await client.query(`insert into public.catalog_publication_revisions (restaurant_id, version)
      values ($1::uuid, $2::bigint) on conflict (restaurant_id) do update set version = excluded.version
      where catalog_publication_revisions.version < excluded.version`, [command.restaurantId, version]);
    const outcome: CommittedCommand = { receipt: { operationId: command.operationId, restaurantId: command.restaurantId,
      phase: "committed", committed: true, retryable: true, version }, result, state, previousSlug: owned?.slug ?? null };
    await writeJournal(client, identity, outcome);
    return outcome;
  });
}

// Internal recovery only: a committed public projection remains publishable after session revocation.
// HTTP gateways must authenticate before allowing a caller to see the private result.
export async function findCommittedCommand(database: Database, identity: CommandIdentity): Promise<CommittedCommand | null> {
  return withTransaction(database, async client => {
    await lock(client, `catalog:operation:${identity.operationId}`);
    return readJournal(client, identity);
  });
}
