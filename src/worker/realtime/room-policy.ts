import type { RealtimeGrant } from "../../modules/realtime/authorization.js";
import type { RealtimeAck } from "../../modules/realtime/contracts.js";

export type RoomAdmission = { environment: "preview" | "production"; origin: string; grant: RealtimeGrant };
export type RealtimeTicket = { ticket: string; restaurantId: string; expiresAt: number };
export type Attachment = { version: 1; admission: RoomAdmission; expiresAt: number; lastSent: number; lastAck: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function parseAdmission(value: unknown): RoomAdmission | null {
  if (!record(value) || !exact(value, ["environment", "origin", "grant"]) ||
    !["preview", "production"].includes(String(value.environment)) || typeof value.origin !== "string") return null;
  try {
    const url = new URL(value.origin);
    if (url.origin !== value.origin || !["https:", "http:"].includes(url.protocol)) return null;
  } catch { return null; }
  const grant = value.grant;
  if (!record(grant) || !validId(grant.restaurantId)) return null;
  if (grant.mode === "owner") {
    if (!exact(grant, ["mode", "restaurantId", "userId", "sessionId", "sessionExpiresAt"]) ||
      !validId(grant.userId) || !validId(grant.sessionId) || !integer(grant.sessionExpiresAt)) return null;
  } else if (grant.mode === "order") {
    if (!exact(grant, ["mode", "restaurantId", "orderId", "tokenFingerprint"]) || !validId(grant.orderId) ||
      typeof grant.tokenFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(grant.tokenFingerprint)) return null;
  } else return null;
  return value as RoomAdmission;
}
export function parseAttachment(value: unknown): Attachment | null {
  if (!record(value) || !exact(value, ["version", "admission", "expiresAt", "lastSent", "lastAck"]) ||
    value.version !== 1 || !parseAdmission(value.admission) || !integer(value.expiresAt) ||
    !integer(value.lastSent) || !integer(value.lastAck) || value.lastAck > value.lastSent) return null;
  return value as Attachment;
}
export function leaseExpiry(grant: RealtimeGrant, now: number): number {
  return Math.min(now + 300_000, grant.mode === "owner" ? grant.sessionExpiresAt : Infinity);
}
export function identity(grant: RealtimeGrant): string {
  return `${grant.mode}:${grant.restaurantId}:${grant.mode === "owner" ? grant.userId : grant.orderId}`;
}
export function scope(grant: RealtimeGrant): string { return grant.mode === "owner" ? "owner" : grant.orderId; }
export function hasCapacity(grants: readonly RealtimeGrant[], incoming: RealtimeGrant): boolean {
  return grants.length < 128 && grants.filter(grant => identity(grant) === identity(incoming)).length < 24;
}
export function parseControl(message: string | ArrayBuffer, lastAck: number, lastSent: number): RealtimeAck | { version: 1; type: "ping" } | null {
  if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > 4096) return null;
  try {
    const value: unknown = JSON.parse(message);
    if (!record(value) || value.version !== 1) return null;
    if (value.type === "ping" && exact(value, ["version", "type"])) return { version: 1, type: "ping" };
    if (value.type === "ack" && exact(value, ["version", "type", "sequence"]) && integer(value.sequence) &&
      value.sequence > lastAck && value.sequence <= lastSent) return { version: 1, type: "ack", sequence: value.sequence };
  } catch {}
  return null;
}
