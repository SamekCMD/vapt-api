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
import { authorizeRestaurant,withRestaurantWrite } from '../tenancy/authorization.js';
import { lockOperation,lockOrganization,lockSlugs } from '../tenancy/locks.js';
import {createOnboardingRepository} from '../onboarding/repository.js';
import { affectsPublicCatalog, allocateOnboardingRestaurantId, fingerprintCommand, validateCatalogCommand } from "./policy.js";

export type CommittedCommand = { receipt: CommandReceipt; result: unknown; state: CatalogState; previousSlug: string | null };

async function mutate(database: Database, client: PoolClient, command: CatalogCommand, publicBaseUrl: URL | null): Promise<unknown> {
  const restaurants = createRestaurantService(createRestaurantRepository(database, {
    transaction: client, onboardingRestaurantId: command.restaurantId,
  }));
  const menu = createMenuService(createMenuRepository(database, { transaction: client }), { publicBaseUrl });
  const { mutation, actor } = command;
  switch (mutation.type) {
    case "onboarding": throw new AppError(410,'legacy_onboarding_retired','Use canonical draft finalization');
    case "onboarding.finalize": return createOnboardingRepository(database,{transaction:client}).finalizeDraft(actor,command.restaurantId,command.operationId);
    case "restaurant.patch": return restaurants.updateRestaurant({ ...actor,restaurantId:command.restaurantId }, mutation.input);
    case "item.create": return menu.createMenuItem({ ...actor,restaurantId:command.restaurantId }, mutation.input);
    case "item.patch": return menu.updateMenuItem({ ...actor,restaurantId:command.restaurantId }, mutation.itemId, mutation.input);
    case "item.delete": await menu.deleteMenuItem({ ...actor,restaurantId:command.restaurantId }, mutation.itemId); return null;
    case "rebuild": return null;
  }
}

export async function applyCatalogCommand(
  database: Database, input: CatalogCommand, options: {
    publicBaseUrl?: URL | null; validateImages?: (command: CatalogCommand) => Promise<void>;
  } = {},
): Promise<CommittedCommand> {
  const command = validateCatalogCommand(input);
  if(command.mutation.type==='onboarding.finalize'&&command.mutation.input.restaurantId!==command.restaurantId)throw commandConflict();
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
    await lockOperation(client,command.operationId);
    const existing = await readJournal(client, identity);
    if (existing) return existing;
    if(command.mutation.type==='onboarding') throw new AppError(410,'legacy_onboarding_retired','Use canonical draft finalization');
    let restaurant:{id:string;slug:string}|undefined;
    const scope={...command.actor,restaurantId:command.restaurantId};
    if(command.mutation.type==='onboarding.finalize'){
      const access=await authorizeRestaurant(client,scope,'restaurant.manage');
      await lockOrganization(client,access.organizationId,'exclusive');
    }
    return withRestaurantWrite(database,scope,'restaurant.manage',async()=>{
    const owned=restaurant!;
    const mutation=command.mutation;
    const imageUrl = mutation.type === "restaurant.patch" ? mutation.input.logoUrl
      : mutation.type === "item.create" || mutation.type === "item.patch" ? mutation.input.imageUrl : null;
    if (imageUrl) {
      if (!options.validateImages) throw new AppError(503, "catalog_image_validation_required", "Image validation unavailable");
      // Same restaurant lock as image retirement. A delayed apply MUST verify after
      // acquiring it, never rely on an object check made before waiting on SQL.
      await options.validateImages(command);
    }
    // Idempotency has a seven-day logical window; expired keys are not permanent tombstones.
    await client.query(`delete from public.catalog_publication_operations
      where operation_id = $1::uuid and expires_at <= clock_timestamp()`, [command.operationId]);
    await client.query(`delete from public.catalog_publication_operations where operation_id in
      (select operation_id from public.catalog_publication_operations where expires_at <= clock_timestamp()
      order by expires_at limit 100)`);
    // A different browser may finalize an already completed restaurant with a
    // new operation key. Keep its receipt, but do not create another revision.
    // Completion predating catalog activation still needs its first snapshot.
    const completedRevision = mutation.type === 'onboarding.finalize'
      ? await client.query<{version:string}>(`select p.version::text as version
          from public.catalog_publication_revisions p join public.restaurants r on r.id=p.restaurant_id
          where r.id=$1::uuid and r.onboarding_status='complete'`, [command.restaurantId])
      : null;
    const result = await mutate(database, client, command, options.publicBaseUrl ?? null);
    const allocated = completedRevision?.rows[0] ? completedRevision : await client.query<{ version: string }>(
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
    },{transaction:client,beforeSession:async current=>{
      const found=await current.query<{id:string;slug:string}>("select id,slug from public.restaurants where id=$1::uuid",[command.restaurantId]);
      restaurant=found.rows[0];
      if(!restaurant) throw new AppError(403,"forbidden","Forbidden");
      const nextSlug=command.mutation.type==="restaurant.patch" && command.mutation.input.slug ? command.mutation.input.slug : restaurant.slug;
      await lockSlugs(current,[restaurant.slug,nextSlug]);
      const locked=await current.query<{slug:string}>("select slug from public.restaurants where id=$1::uuid for update",[command.restaurantId]);
      if(locked.rows[0]?.slug!==restaurant.slug) throw commandConflict();
    }});
  });
}

// Internal recovery only: a committed public projection remains publishable after session revocation.
// HTTP gateways must authenticate before allowing a caller to see the private result.
export async function findCommittedCommand(database: Database, identity: CommandIdentity): Promise<CommittedCommand | null> {
  return withTransaction(database, async client => {
    await lockOperation(client,identity.operationId);
    return readJournal(client, identity);
  });
}
