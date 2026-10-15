import type { R2Bucket } from "@cloudflare/workers-types";
import { AppError } from "../../lib/errors.js";
import { RESTAURANT_IMAGE_QUOTA_BYTES } from "../../modules/storage/policy.js";
import type { MenuImageGateway, MenuImageContentType } from "../../modules/storage/service.js";
import type { ImageInventoryEntry, ImageReservation, ImageReservationInput, SqliteImageBudget } from "./image-budget.js";

export type ImageUploadDescriptor = { state: "uploaded"; objectKey: string; publicUrl: string } | {
  state: "upload_required"; objectKey: string; publicUrl: string; method: "PUT"; uploadUrl: string;
  headers: { "Content-Type": MenuImageContentType; "If-Match": string }; expiresInSeconds: number;
};
export type ImageUploadPorts = {
  budget: SqliteImageBudget;
  bucket: Pick<R2Bucket, "head" | "put" | "list" | "delete">;
  signer: Pick<MenuImageGateway, "createUploadUrl">;
  publicBaseUrl: URL; now(): number;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  atomic<T>(work: () => T): Promise<T>;
  assertCanRetire(objectKey: string): Promise<void>;
};

const unavailable = () => new AppError(503, "menu_image_storage_unavailable", "Image storage unavailable");
const gone = () => new AppError(410, "menu_image_upload_expired", "Image upload expired");

export function createImageUploads(ports: ImageUploadPorts) {
  const { budget, bucket } = ports;
  function run<T>(work: () => Promise<T>): Promise<T> {
    return ports.exclusive(async () => {
      try { return await work(); } catch (error) {
        if (error instanceof AppError) throw error;
        throw unavailable(); // No SDK errors, signed URLs or secrets in diagnostics.
      }
    });
  }
  function requireLease(id: string): ImageReservation {
    const lease = budget.get(id);
    if (!lease) throw new AppError(404, "menu_image_upload_not_found", "Image upload not found");
    if (lease.state === "retired") throw gone();
    return lease;
  }
  function publicUrl(lease: ImageReservation): string {
    const base = new URL(ports.publicBaseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(lease.objectKey.split("/").map(encodeURIComponent).join("/"), base).toString();
  }
  async function inventory(id: string): Promise<ImageInventoryEntry[]> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(400, "invalid_menu_image_upload", "Invalid image upload");
    const objects: ImageInventoryEntry[] = [];
    const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await bucket.list({ prefix: `${id}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      objects.push(...result.objects.map(({ key, size }) => ({ key, size })));
      if (objects.length > 1000) throw unavailable();
      if (!result.truncated) return objects;
      if (!result.cursor || cursors.has(result.cursor)) throw unavailable();
      cursors.add(result.cursor); cursor = result.cursor;
    }
    throw unavailable();
  }
  async function verify(lease: ImageReservation): Promise<boolean> {
    const object = await bucket.head(lease.objectKey);
    if (lease.state === "reserved" || !object || object.etag === lease.fenceEtag
      || object.customMetadata?.vaptImage !== undefined
      || object.size !== lease.bytes || object.httpMetadata?.contentType !== lease.contentType) return false;
    if (lease.state !== "uploaded") await ports.atomic(() => budget.uploaded(lease.leaseId));
    return true;
  }
  return {
    prepare(input: ImageReservationInput): Promise<ImageUploadDescriptor> { return run(async () => {
      const objects = await inventory(input.restaurantId);
      let lease = await ports.atomic(() => budget.reserve({ ...input, now: ports.now() }, objects));
      if (budget.usage(input.restaurantId, objects) > RESTAURANT_IMAGE_QUOTA_BYTES) {
        throw new AppError(413, "menu_image_quota_exceeded", "Restaurant image quota exceeded");
      }
      if (lease.state === "retired") throw gone();
      if (lease.state !== "reserved" && await verify(lease)) return { state: "uploaded", objectKey: lease.objectKey, publicUrl: publicUrl(lease) };
      if (ports.now() >= lease.expiresAt) throw gone();
      if (lease.state === "reserved") {
        lease = await ports.atomic(() => budget.stageAttempt(lease.leaseId));
        const existing = await bucket.head(lease.objectKey);
        if (existing && existing.customMetadata?.vaptImage !== "staging") throw unavailable();
        const staged = await bucket.put(lease.objectKey, crypto.randomUUID(), {
          onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "text/plain" }, customMetadata: { vaptImage: "staging" },
        });
        if (!staged) throw unavailable();
        lease = await ports.atomic(() => budget.staged(lease.leaseId, staged.etag));
      }
      const current = await bucket.head(lease.objectKey);
      if (!current || current.etag !== lease.fenceEtag || current.customMetadata?.vaptImage !== "staging") throw unavailable();
      const expiresInSeconds = Math.floor((lease.expiresAt - ports.now()) / 1000);
      if (expiresInSeconds < 1) throw gone();
      const ifMatch = current.httpEtag;
      const uploadUrl = await ports.signer.createUploadUrl({ objectKey: lease.objectKey,
        contentType: lease.contentType, contentLength: lease.bytes, ifMatch, expiresInSeconds });
      return { state: "upload_required", method: "PUT", objectKey: lease.objectKey, publicUrl: publicUrl(lease), uploadUrl,
        headers: { "Content-Type": lease.contentType, "If-Match": ifMatch }, expiresInSeconds };
    }); },
    verify(leaseId: string): Promise<void> { return run(async () => {
      if (!await verify(requireLease(leaseId))) throw new AppError(409, "menu_image_upload_pending", "Image upload is not complete");
    }); },
    retire(leaseId: string): Promise<void> { return run(async () => {
      const lease = budget.get(leaseId);
      if (!lease) throw new AppError(404, "menu_image_upload_not_found", "Image upload not found");
      if (lease.state === "retired") return;
      // Required production adapter: no unresolved catalog command, fresh SQL
      // revision == ready R2 version, neither current nor previous snapshot uses
      // this URL. It must share the same exclusive queue as command execution.
      await ports.assertCanRetire(lease.objectKey);
      const uncertainCreator = lease.state === "reserved" ? lease.stagingAttempts > 0 : lease.stagingAttempts > 1;
      if (uncertainCreator) {
        const object = await bucket.head(lease.objectKey);
        const retired = await bucket.put(lease.objectKey, crypto.randomUUID(), {
          onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "text/plain" }, customMetadata: { vaptImage: "retired" },
        });
        if (!retired) throw unavailable();
      } else if (lease.stagingAttempts > 0) await bucket.delete(lease.objectKey);
      await ports.atomic(() => budget.retired(leaseId, uncertainCreator ? 36 : 0, ports.now()));
    }); },
  };
}
