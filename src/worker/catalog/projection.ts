import type { R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { compareVersion } from "../../modules/catalog-publication/contracts.js";
import type { CatalogState } from "../../modules/catalog-publication/contracts.js";
import type { CommittedCommand } from "../../modules/catalog-publication/transaction.js";

export type CatalogProjection = {
  publish(committed: CommittedCommand): Promise<CatalogState>;
  readBySlug(slug: string): Promise<CatalogState>;
  readRegistration(restaurantId: string): Promise<{ version: string; canonicalSlug: string }>;
  prune(restaurantId: string, cursor?: string): Promise<{ cursor?: string }>;
};

const version = z.string().refine(value => { try { compareVersion(value, "1"); return true; } catch { return false; } });
const slug = z.string().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nullableText = z.string().nullable();
const stateSchema = z.object({ version, catalog: z.object({
  restaurant: z.object({
    id: z.string().uuid(), name: z.string(), slug, whatsapp: nullableText, address: nullableText,
    phone: nullableText, hours: nullableText, description: nullableText, primaryColor: z.string(),
    secondaryColor: z.string(), fontFamily: z.string(), logoUrl: nullableText,
    totalTables: z.number().int(), maxTables: z.number().int(), paymentMode: z.enum(["open_tab", "prepaid"]),
    maxPendingOrders: z.number().int(), localEnabled: z.boolean(), deliveryEnabled: z.boolean(), updatedAt: z.string(),
  }).strict(),
  items: z.array(z.object({ id: z.string().uuid(), restaurantId: z.string().uuid(), name: z.string(), price: z.string(),
    description: nullableText, category: z.string(), available: z.boolean(), imageUrl: nullableText,
    availableFrom: nullableText, availableUntil: nullableText, badge: nullableText, isChefSuggestion: z.boolean(),
    prepTimeMinutes: z.number().int().nullable(), createdAt: z.string(), updatedAt: z.string(),
    variations: z.array(z.object({ id: z.string().uuid(), name: z.string(), options: z.array(z.string()), required: z.boolean() }).strict()),
  }).strict()),
}).strict() }).strict();
const manifestSchema = z.object({ restaurantId: z.string().uuid(), version, canonicalSlug: slug,
  previousVersion: version.nullable() }).strict();
const mappingSchema = z.object({ restaurantId: z.string().uuid(), version, canonicalSlug: slug, tombstone: z.boolean() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Mapping = z.infer<typeof mappingSchema>;

function unavailable(): AppError { return new AppError(503, "catalog_publication_unavailable", "Public catalog publication unavailable"); }
function missing(): AppError { return new AppError(404, "not_found", "Restaurant not found"); }

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable(); // Never expose R2/Zod messages, inputs, credentials or private result data.
  }
}

export function createCatalogProjection(bucket: Pick<R2Bucket, "get" | "put" | "list">, environment: "preview" | "production"): CatalogProjection {
  if (!["preview", "production"].includes(environment)) throw unavailable();
  const prefix = `catalog/v1/${environment}/`;
  const restaurantPrefix = (id: string) => `${prefix}restaurants/${id}/`;
  const manifestKey = (id: string) => `${restaurantPrefix(id)}manifest.json`;
  const snapshotKey = (id: string, revision: string) => `${restaurantPrefix(id)}snapshots/${revision}.json`;
  const slugKey = (name: string) => `${prefix}slugs/${name}.json`;
  async function manifest(id: string) {
    const object = await bucket.get(manifestKey(id));
    if (!object) return null;
    if (object.size > 4096) throw unavailable();
    const value = manifestSchema.parse(await object.json());
    if (value.restaurantId !== id || (value.previousVersion && compareVersion(value.previousVersion, value.version) >= 0)) throw unavailable();
    return { value, etag: object.etag };
  }
  async function snapshot(value: Manifest): Promise<CatalogState> {
    const object = await bucket.get(snapshotKey(value.restaurantId, value.version));
    if (!object || object.size > 8_388_608) throw unavailable();
    const state = stateSchema.parse(await object.json());
    if (state.version !== value.version || state.catalog.restaurant.id !== value.restaurantId
      || state.catalog.restaurant.slug !== value.canonicalSlug
      || state.catalog.items.some(item => item.restaurantId !== value.restaurantId)) throw unavailable();
    return state;
  }
  async function mapping(name: string) {
    const object = await bucket.get(slugKey(name));
    if (!object) return null;
    if (object.size > 4096) throw unavailable();
    return { value: mappingSchema.parse(await object.json()), etag: object.etag };
  }
  async function saveMapping(name: string, next: Mapping): Promise<void> {
    const current = await mapping(name);
    if (current) {
      const order = compareVersion(current.value.version, next.version);
      if (order > 0 && next.tombstone) return;
      if (order > 0) throw unavailable();
      if (order === 0) {
        if (JSON.stringify(current.value) !== JSON.stringify(next)) throw unavailable();
        return;
      }
    }
    const put = await bucket.put(slugKey(name), JSON.stringify(next), { onlyIf: current
      ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" } });
    if (put) return;
    const latest = await mapping(name);
    if (latest && next.tombstone && compareVersion(latest.value.version, next.version) > 0) return;
    if (latest && JSON.stringify(latest.value) === JSON.stringify(next)) return;
    throw unavailable();
  }
  return {
    readBySlug(name) { return safe(async () => {
      if (!slug.safeParse(name).success) throw missing();
      const address = await mapping(name);
      if (!address || address.value.tombstone) throw missing();
      const current = await manifest(address.value.restaurantId);
      if (!current || current.value.canonicalSlug !== name || address.value.canonicalSlug !== name
        || current.value.version !== address.value.version) throw unavailable();
      return snapshot(current.value);
    }); },
    readRegistration(id) { return safe(async () => {
      if (!z.string().uuid().safeParse(id).success) throw missing();
      const current = await manifest(id);
      if (!current) throw missing();
      return { version: current.value.version, canonicalSlug: current.value.canonicalSlug };
    }); },
    publish(committed) { return safe(async () => {
      const state = stateSchema.parse(committed.state);
      const { id, slug: nextSlug } = state.catalog.restaurant;
      if (committed.receipt.restaurantId !== id || committed.receipt.version !== state.version
        || state.catalog.items.some(item => item.restaurantId !== id)) throw unavailable();
      const bytes = JSON.stringify(state);
      if (new TextEncoder().encode(bytes).byteLength > 8_388_608) throw unavailable();
      const current = await manifest(id);
      if (current && compareVersion(current.value.version, state.version) >= 0) return snapshot(current.value);
      const key = snapshotKey(id, state.version);
      const put = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
      if (!put) {
        const existing = await bucket.get(key);
        if (!existing || existing.size > 8_388_608
          || JSON.stringify(stateSchema.parse(await existing.json())) !== bytes) throw unavailable();
      }
      await saveMapping(nextSlug, { restaurantId: id, version: state.version, canonicalSlug: nextSlug, tombstone: false });
      if (committed.previousSlug && committed.previousSlug !== nextSlug) {
        const previous = slug.parse(committed.previousSlug);
        await saveMapping(previous, { restaurantId: id, version: state.version, canonicalSlug: nextSlug, tombstone: true });
      }
      const next: Manifest = { restaurantId: id, version: state.version, canonicalSlug: nextSlug,
        previousVersion: current?.value.version ?? null };
      const ready = await bucket.put(manifestKey(id), JSON.stringify(next), { onlyIf: current
        ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" } });
      if (!ready) throw unavailable();
      return state;
    }); },
    prune(id, cursor) { return safe(async () => {
      if (!z.string().uuid().safeParse(id).success) throw missing();
      const current = await manifest(id);
      if (!current) throw missing();
      const snapshots = `${restaurantPrefix(id)}snapshots/`;
      const page = await bucket.list({ prefix: snapshots, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const entry of page.objects) {
        const candidate = entry.key.slice(snapshots.length).replace(/\.json$/, "");
        if (!version.safeParse(candidate).success || candidate === current.value.previousVersion
          || compareVersion(candidate, current.value.version) >= 0) continue;
        const object = await bucket.get(entry.key);
        if (!object) continue;
        const tombstone = JSON.stringify({ retired: true, version: candidate });
        if (object.size <= 128 && JSON.stringify(await object.json()) === tombstone) continue;
        // Keep a small create-once fence: DELETE would allow a timed-out old PUT to resurrect the full payload.
        const retired = await bucket.put(entry.key, tombstone, { onlyIf: { etagMatches: object.etag } });
        if (!retired) throw unavailable();
      }
      return page.truncated ? { cursor: page.cursor } : {};
    }); },
  };
}
