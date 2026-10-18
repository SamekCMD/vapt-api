import { withTransaction, type Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { CatalogActor, CatalogCommand } from "../../modules/catalog-publication/contracts.js";
import type { MenuImageContentType } from "../../modules/storage/service.js";
import type { SqliteImageBudget } from "./image-budget.js";
import type { ImageUploadDescriptor, ImageUploadPorts } from "./image-uploads.js";
import type { CatalogProjection } from "./projection.js";
import { createImageUploads } from "./image-uploads.js";
import { MENU_IMAGE_MAX_BYTES } from "../../modules/storage/policy.js";

export type CatalogImageAccess = { restaurantId: string; itemId: string; actor: CatalogActor };
export type CatalogImagePrepare = CatalogImageAccess & { leaseId: string; contentType: MenuImageContentType; contentLength: number };
export type CatalogImageRetire = CatalogImageAccess & { objectKey: string };
export type CatalogImageReconcile = Pick<CatalogImageAccess, "restaurantId" | "actor">;
export type CatalogImageServicePorts = {
  database: Database; budget: SqliteImageBudget;
  bucket: ImageUploadPorts["bucket"]; signer: ImageUploadPorts["signer"];
  publicBaseUrl: URL; ttlMs: number; now(): number;
  exclusive: ImageUploadPorts["exclusive"]; atomic: ImageUploadPorts["atomic"];
  hasUnresolvedCommands(): boolean;
  projection: Pick<CatalogProjection, "readRetainedCatalogs">;
};

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const actorSchema = z.object({ userId: uuid, sessionId: uuid, sessionExpiresAt: z.number().int().positive() }).strict();
const accessSchema = z.object({ restaurantId: uuid, itemId: uuid, actor: actorSchema }).strict();
const prepareSchema = accessSchema.extend({ leaseId: uuid, contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentLength: z.number().int().positive().max(MENU_IMAGE_MAX_BYTES) });
const retireSchema = accessSchema.extend({ objectKey: z.string().min(1).max(200) });
const reconcileSchema = accessSchema.omit({ itemId: true });
const blocked = () => new AppError(409, "menu_image_cleanup_pending", "Image cleanup is not safe yet");

export function createCatalogImageService(ports: CatalogImageServicePorts) {
  async function ownerLock<T>(access: CatalogImageReconcile & { itemId?: string }, requireItem: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (access.actor.sessionExpiresAt <= ports.now()) throw new AppError(401, "unauthorized", "Unauthorized");
    return withTransaction(ports.database, async client => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`catalog:owner:${access.actor.userId}`]);
      const owned = await client.query<{ id: string }>("select id from public.restaurants where id = $1::uuid and owner_id = $2::uuid for update",
        [access.restaurantId, access.actor.userId]);
      if (!owned.rows[0]) throw new AppError(403, "forbidden", "Forbidden");
      const active = await client.query<{ id: string }>(`select id from better_auth."session"
        where id = $1::uuid and "userId" = $2::uuid and "expiresAt" > clock_timestamp() for share`, [access.actor.sessionId, access.actor.userId]);
      if (!active.rows[0]) throw new AppError(401, "unauthorized", "Unauthorized");
      if (requireItem) {
        const item = await client.query<{ id: string }>("select id from public.menu_items where id = $1::uuid and restaurant_id = $2::uuid", [access.itemId, access.restaurantId]);
        if (!item.rows[0]) throw new AppError(404, "menu_item_not_found", "Menu item not found");
      }
      return work(client);
    });
  }
  function assertKey(key: string, restaurantId: string, itemId?: string): void {
    const parts = key.split("/");
    if (parts.length !== 3 || !parts.every(part => uuid.safeParse(part).success)
      || parts[0] !== restaurantId || (itemId && parts[1] !== itemId)) {
      throw new AppError(400, "invalid_image_key", "Invalid image key");
    }
  }
  function sameObject(reference: string | null, key: string): boolean {
    if (!reference) return false;
    try {
      const candidate = new URL(reference);
      const base = new URL(ports.publicBaseUrl); if (!base.pathname.endsWith("/")) base.pathname += "/";
      const target = new URL(key, base);
      // Queries/fragments do not select a different underlying R2 object.
      return candidate.origin === target.origin && decodeURIComponent(candidate.pathname) === decodeURIComponent(target.pathname);
    } catch { throw new AppError(503, "catalog_image_reference_invalid", "Image reference unavailable"); }
  }
  function uploads(assertCanRetire: (key: string) => Promise<void>) {
    return createImageUploads({ ...ports, exclusive: work => work(), assertCanRetire });
  }
  async function retirementGuard(client: PoolClient, restaurantId: string) {
    if (ports.hasUnresolvedCommands()) throw blocked();
    const revision = await client.query<{ version: string }>("select version::text as version from public.catalog_publication_revisions where restaurant_id = $1::uuid", [restaurantId]);
    const retained = await ports.projection.readRetainedCatalogs(restaurantId);
    if (!revision.rows[0] || !retained.length || retained[0]!.version !== revision.rows[0].version
      || retained.some(state => state.catalog.restaurant.id !== restaurantId)) throw blocked();
    return (key: string) => retained.some(state => sameObject(state.catalog.restaurant.logoUrl, key)
      || state.catalog.items.some(item => sameObject(item.imageUrl, key)));
  }
  return {
    async prepare(input: CatalogImagePrepare): Promise<ImageUploadDescriptor> {
      const access = validateWithSchema(prepareSchema, input);
      return ports.exclusive(() => ownerLock(access, true, async () => uploads(async () => { throw blocked(); }).prepare({
        leaseId: access.leaseId, restaurantId: access.restaurantId, itemId: access.itemId,
        contentType: access.contentType, bytes: access.contentLength, now: ports.now(), ttlMs: ports.ttlMs,
      })));
    },
    async retire(input: CatalogImageRetire): Promise<void> {
      const access = validateWithSchema(retireSchema, input);
      assertKey(access.objectKey, access.restaurantId, access.itemId);
      return ports.exclusive(() => ownerLock(access, false, async client => {
        const lease = ports.budget.getByObjectKey(access.objectKey);
        if (!lease) throw new AppError(404, "menu_image_upload_not_found", "Image upload not found");
        await uploads(async key => {
          const referenced = await retirementGuard(client, access.restaurantId);
          if (referenced(key)) throw blocked();
        }).retire(lease.leaseId);
      }));
    },
    async reconcile(input: CatalogImageReconcile): Promise<{ checked: number; retired: number; protected: number }> {
      const access = validateWithSchema(reconcileSchema, input);
      return ports.exclusive(() => ownerLock(access, false, async client => {
        const candidates = ports.budget.cleanupCandidates(access.restaurantId, ports.now());
        const result = { checked: candidates.length, retired: 0, protected: 0 };
        if (!candidates.length) return result;
        const referenced = await retirementGuard(client, access.restaurantId);
        const storage = uploads(async key => { if (referenced(key)) throw blocked(); });
        for (const lease of candidates) {
          assertKey(lease.objectKey, access.restaurantId, lease.itemId);
          await ports.atomic(() => ports.budget.cleanupChecked(lease.leaseId, ports.now()));
          if (referenced(lease.objectKey)) { result.protected++; continue; }
          // Expiry only selects candidates. The existing physical retirement and
          // uncertain-creator fence must succeed before any quota is released.
          await storage.retire(lease.leaseId); result.retired++;
        }
        return result;
      }));
    },
    // Internal applier hook ONLY: caller already holds PG owner/session locks
    // and the shared queue. Taking either lock again here would deadlock.
    async validateAttachment(command: CatalogCommand): Promise<void> {
      const mutation = command.mutation;
      const reference = mutation.type === "restaurant.patch" ? mutation.input.logoUrl
        : mutation.type === "item.create" || mutation.type === "item.patch" ? mutation.input.imageUrl : null;
      if (!reference) return;
      let url: URL;
      try { url = new URL(reference); } catch { throw new AppError(400, "invalid_image_url", "Invalid image URL"); }
      if (url.protocol !== "https:" || url.username || url.password) throw new AppError(400, "invalid_image_url", "Invalid image URL");
      if (mutation.type === "restaurant.patch" && url.origin !== ports.publicBaseUrl.origin) return;
      const basePath = ports.publicBaseUrl.pathname.replace(/\/?$/, "/");
      if (url.origin !== ports.publicBaseUrl.origin || !url.pathname.startsWith(basePath) || url.search || url.hash) {
        throw new AppError(400, "invalid_image_url", "Invalid image URL");
      }
      const key = url.pathname.slice(basePath.length);
      if (key.split("/")[0] !== command.restaurantId) throw new AppError(403, "forbidden", "Forbidden");
      const parts = key.split("/");
      if (parts.length === 2 && parts.every(part => uuid.safeParse(part).success)) {
        // Legacy references remain usable only after cutover proves old PUT URLs
        // drained. Automatic deletion of legacy keys is deliberately not allowed.
        const object = await ports.bucket.head(key);
        if (!object || object.size < 1 || object.size > 5_242_880 || object.customMetadata?.vaptImage
          || !["image/jpeg", "image/png", "image/webp"].includes(object.httpMetadata?.contentType ?? "")) throw blocked();
        return;
      }
      assertKey(key, command.restaurantId);
      const lease = ports.budget.getByObjectKey(key);
      if (!lease) throw new AppError(410, "menu_image_upload_expired", "Image upload expired");
      await uploads(async () => { throw blocked(); }).verify(lease.leaseId);
    },
  };
}
