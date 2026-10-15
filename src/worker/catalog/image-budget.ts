import type { SqlStorage } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import type { MenuImageContentType } from "../../modules/storage/service.js";
import { MENU_IMAGE_MAX_BYTES, RESTAURANT_IMAGE_QUOTA_BYTES } from "../../modules/storage/policy.js";

export type ImageInventoryEntry = { key: string; size: number };
export type ImageReservation = {
  leaseId: string; restaurantId: string; itemId: string; objectKey: string;
  contentType: MenuImageContentType; bytes: number; expiresAt: number;
  state: "reserved" | "staged" | "uploaded" | "retired";
  stagingAttempts: number; fenceEtag?: string; retiredBytes?: number; retiredAt?: number;
};
export type ImageReservationInput = Pick<ImageReservation, "leaseId" | "restaurantId" | "itemId" | "contentType" | "bytes"> & {
  now: number; ttlMs: number;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fenceBytes = 36;
const unavailable = () => new AppError(503, "menu_image_inventory_unavailable", "Image inventory unavailable");

export class SqliteImageBudget {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("create table if not exists catalog_image_scope(singleton integer primary key check(singleton = 1), restaurant_id text not null)");
    sql.exec("create table if not exists catalog_image_leases(lease_id text primary key, reservation text not null)");
  }

  // Caller serializes with catalog work and commits/syncs this reservation BEFORE
  // creating any R2 object or signing a PUT. Time alone never releases bytes.
  reserve(input: ImageReservationInput, inventory: readonly ImageInventoryEntry[]): ImageReservation {
    if (![input.restaurantId, input.itemId, input.leaseId].every(value => typeof value === "string" && uuid.test(value))
      || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MENU_IMAGE_MAX_BYTES
      || !["image/jpeg", "image/png", "image/webp"].includes(input.contentType)
      || !Number.isSafeInteger(input.now) || input.now < 0
      || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 900_000
      || !Number.isSafeInteger(input.now + input.ttlMs)) {
      throw new AppError(400, "invalid_menu_image_upload", "Invalid image upload");
    }
    this.assertScope(input.restaurantId);
    this.sql.exec(`delete from catalog_image_leases where lease_id in (
      select lease_id from catalog_image_leases where json_extract(reservation, '$.state') = 'retired'
      and json_extract(reservation, '$.retiredAt') <= ? order by lease_id limit 100)`, input.now - 604_800_000);
    const existing = this.get(input.leaseId);
    if (existing) {
      if (existing.itemId !== input.itemId || existing.bytes !== input.bytes || existing.contentType !== input.contentType) {
        throw new AppError(409, "menu_image_upload_conflict", "Image upload conflicts with existing work");
      }
      return existing;
    }
    const currentUsage = this.inventoryUsage(input.restaurantId, inventory);
    if (currentUsage.bytes + Math.max(input.bytes, fenceBytes) > RESTAURANT_IMAGE_QUOTA_BYTES) {
      throw new AppError(413, "menu_image_quota_exceeded", "Restaurant image quota exceeded");
    }
    if (currentUsage.objects >= 1000) throw new AppError(429, "menu_image_inventory_full", "Image storage requires cleanup");
    const total = this.sql.exec<{ total: number; pending: number }>(`select count(*) as total,
      coalesce(sum(case when json_extract(reservation, '$.state') in ('reserved', 'staged') then 1 else 0 end), 0) as pending
      from catalog_image_leases`).toArray()[0]!;
    if (total.pending >= 10) throw new AppError(429, "menu_image_uploads_pending", "Too many pending image uploads");
    if (total.total >= 1000) throw new AppError(429, "menu_image_history_full", "Image upload history requires cleanup");
    const reservation: ImageReservation = { leaseId: input.leaseId, restaurantId: input.restaurantId, itemId: input.itemId,
      objectKey: `${input.restaurantId}/${input.itemId}/${crypto.randomUUID()}`, contentType: input.contentType,
      bytes: input.bytes, expiresAt: input.now + input.ttlMs, state: "reserved", stagingAttempts: 0 };
    this.sql.exec("insert into catalog_image_scope(singleton, restaurant_id) values(1, ?) on conflict(singleton) do nothing", input.restaurantId);
    this.sql.exec("insert into catalog_image_leases(lease_id, reservation) values(?, ?)", input.leaseId, JSON.stringify(reservation));
    return reservation;
  }

  get(leaseId: string): ImageReservation | null {
    const row = this.sql.exec<{ reservation: string }>("select reservation from catalog_image_leases where lease_id = ?", leaseId).toArray()[0];
    return row ? JSON.parse(row.reservation) as ImageReservation : null;
  }

  stageAttempt(leaseId: string): ImageReservation {
    const lease = this.require(leaseId);
    if (lease.state !== "reserved") throw new AppError(409, "menu_image_upload_conflict", "Image upload conflicts with existing work");
    if (lease.stagingAttempts >= 10) throw new AppError(429, "menu_image_staging_blocked", "Image staging requires cleanup");
    return this.save({ ...lease, stagingAttempts: lease.stagingAttempts + 1 });
  }
  staged(leaseId: string, etag: string): ImageReservation {
    const lease = this.require(leaseId);
    return this.save({ ...lease, state: "staged", fenceEtag: etag });
  }
  uploaded(leaseId: string): ImageReservation { return this.save({ ...this.require(leaseId), state: "uploaded" }); }
  retired(leaseId: string, bytes: 0 | 36, now: number): ImageReservation {
    return this.save({ ...this.require(leaseId), state: "retired", retiredBytes: bytes, retiredAt: now });
  }

  usage(restaurantId: string, inventory: readonly ImageInventoryEntry[]): number {
    return this.inventoryUsage(restaurantId, inventory).bytes;
  }

  private inventoryUsage(restaurantId: string, inventory: readonly ImageInventoryEntry[]): { bytes: number; objects: number } {
    this.assertScope(restaurantId);
    // No truncated/paginated inventory is admissible. The R2 adapter must collect
    // the bounded listing first; metadata markers and legacy image keys count too.
    if (inventory.length > 1000) throw unavailable();
    const sizes = new Map<string, number>();
    for (const object of inventory) {
      if (!object.key.startsWith(`${restaurantId}/`) || !Number.isSafeInteger(object.size) || object.size < 0 || sizes.has(object.key)) throw unavailable();
      sizes.set(object.key, object.size);
    }
    const leases = this.sql.exec<{ reservation: string }>("select reservation from catalog_image_leases").toArray();
    for (const row of leases) {
      const lease = JSON.parse(row.reservation) as ImageReservation;
      const reserved = lease.state === "retired" ? lease.retiredBytes! : Math.max(lease.bytes, fenceBytes);
      if (reserved > 0 || sizes.has(lease.objectKey)) sizes.set(lease.objectKey, Math.max(sizes.get(lease.objectKey) ?? 0, reserved));
    }
    let bytes = 0;
    for (const size of sizes.values()) {
      bytes += size;
      if (!Number.isSafeInteger(bytes)) throw unavailable();
    }
    return { bytes, objects: sizes.size };
  }

  private assertScope(restaurantId: string): void {
    const scope = this.sql.exec<{ restaurant_id: string }>("select restaurant_id from catalog_image_scope where singleton = 1").toArray()[0];
    if (scope && scope.restaurant_id !== restaurantId) throw new AppError(409, "catalog_room_conflict", "Image room does not match restaurant");
  }
  private require(leaseId: string): ImageReservation {
    const lease = this.get(leaseId);
    if (!lease) throw new AppError(404, "menu_image_upload_not_found", "Image upload not found");
    return lease;
  }
  private save(lease: ImageReservation): ImageReservation {
    this.sql.exec("update catalog_image_leases set reservation = ? where lease_id = ?", JSON.stringify(lease), lease.leaseId);
    return lease;
  }
}
