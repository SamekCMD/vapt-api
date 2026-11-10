import type { WorkerBindings } from "../environment.js";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { compareVersion } from "../../modules/catalog-publication/contracts.js";
export type CatalogSocketAdmission = { restaurantId: string; environment: "preview" | "production"; origin: string };
export type CatalogSocketAttachment = { protocol: "vapt.catalog.v1"; restaurantId: string; environment: "preview" | "production"; lastSentVersion: string };
export function isCatalogReaderEnabled(env: WorkerBindings): boolean {
  if (env.PUBLIC_CATALOG_READER_ENABLED === undefined || env.PUBLIC_CATALOG_READER_ENABLED === "false") return false;
  if (env.PUBLIC_CATALOG_READER_ENABLED === "true" && env.PUBLIC_CATALOG_WRITER_ENABLED === "true") return true;
  throw new AppError(503, "catalog_configuration_invalid", "Public catalog unavailable");
}
export function admitCatalogSocket(request: Request, env: WorkerBindings): CatalogSocketAdmission {
  if (!isCatalogReaderEnabled(env)) throw new AppError(404, "not_found", "Route not found");
  const url = new URL(request.url);
  const match = /^\/v1\/catalog\/restaurants\/([a-fA-F0-9-]{36})\/socket$/.exec(url.pathname);
  if (request.method !== "GET" || !match || !z.string().uuid().safeParse(match[1]).success || url.search
    || request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    || (request.headers.has("Sec-WebSocket-Protocol") && request.headers.get("Sec-WebSocket-Protocol") !== "vapt.catalog.v1")) {
    throw new AppError(400, "invalid_request", "Invalid request");
  }
  const origin = request.headers.get("Origin"); let validOrigin = false;
  try { validOrigin = !!origin && new URL(origin).origin === origin && ["http:", "https:"].includes(new URL(origin).protocol); } catch {}
  if (!validOrigin || !(env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).includes(origin!)) throw new AppError(403, "forbidden", "Forbidden");
  return { restaurantId: match[1]!.toLowerCase(), environment: env.ENVIRONMENT, origin: origin! };
}
const attachmentSchema = z.object({ protocol: z.literal("vapt.catalog.v1"), restaurantId: z.string().uuid(),
  environment: z.enum(["preview", "production"]), lastSentVersion: z.string().refine(value => { try { compareVersion(value, "1"); return true; } catch { return false; } }) }).strict();
export function parseCatalogAttachment(value: unknown): CatalogSocketAttachment | null {
  const result = attachmentSchema.safeParse(value); return result.success ? result.data : null;
}
export function catalogSocketHasCapacity(count: number): boolean { return Number.isInteger(count) && count >= 0 && count < 200; }
export function catalogClientFrameCloseCode(message: string | ArrayBuffer): number {
  return typeof message !== "string" ? 1003 : new TextEncoder().encode(message).byteLength > 512 ? 1009 : 1008;
}
