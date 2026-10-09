import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { validId, type RealtimeTicket } from "./room-policy.js";

type Audience = { environment: "preview" | "production"; origin: string; restaurantId: string };
const encoded = /^rt1\.([A-Za-z0-9_-]{43})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;
export const hasIngressKey = (key: string | undefined): key is string => typeof key === "string" && key.trim().length >= 32;
function validAudience(audience: Audience): boolean {
  if (!["preview", "production"].includes(audience.environment) || !validId(audience.restaurantId)) return false;
  try { return new URL(audience.origin).origin === audience.origin && ["https:", "http:"].includes(new URL(audience.origin).protocol); }
  catch { return false; }
}
function live(expiresAt: number, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + 30_000;
}
function digest(raw: string, expiresAt: number, audience: Audience, key: string): Buffer {
  return createHmac("sha256", key).update(JSON.stringify([
    "vapt.realtime.ingress.v1", audience.environment, audience.origin, audience.restaurantId.toLowerCase(), raw, expiresAt,
  ])).digest();
}
// This proof prevents forged room allocation. It does NOT replace the room's single-use grant checks.
export function signIngressTicket(ticket: RealtimeTicket, audience: Audience, key: string | undefined, now: number): string {
  if (!hasIngressKey(key) || !validAudience(audience) || ticket.restaurantId !== audience.restaurantId.toLowerCase() ||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket) || !live(ticket.expiresAt, now)) throw new Error("Invalid realtime admission");
  return `rt1.${ticket.ticket}.${ticket.expiresAt}.${digest(ticket.ticket, ticket.expiresAt, audience, key).toString("base64url")}`;
}
export function verifyIngressTicket(protocolHeader: string | undefined, audience: Audience, key: string | undefined, now: number): string | null {
  if (!hasIngressKey(key) || !validAudience(audience) || !protocolHeader || protocolHeader.length > 192) return null;
  const protocols = protocolHeader.split(",").map(value => value.trim());
  if (protocols.length !== 2 || protocols.filter(value => value === "vapt.realtime.v1").length !== 1) return null;
  const ticket = protocols.find(value => value.startsWith("vapt.ticket."))?.slice(12);
  const match = ticket?.match(encoded);
  if (!match || !live(Number(match[2]), now)) return null;
  const expected = digest(match[1], Number(match[2]), audience, key);
  const supplied = Buffer.from(match[3], "base64url");
  if (supplied.length !== 32 || supplied.toString("base64url") !== match[3] || !timingSafeEqual(supplied, expected)) return null;
  return match[1];
}
