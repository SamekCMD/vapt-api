import { z } from "zod";

import { createMenuItemBodySchema, updateMenuItemBodySchema } from "../menu/schemas.js";
import { onboardingBodySchema, updateOwnedRestaurantBodySchema } from "../restaurants/schemas.js";
import type { CatalogCommand } from "./contracts.js";

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const commandSchema = z.object({
  operationId: uuid,
  restaurantId: uuid,
  actor: z.object({ userId: uuid, sessionId: uuid, sessionExpiresAt: z.number().int().positive() }).strict(),
  mutation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("onboarding"), input: onboardingBodySchema }).strict(),
    z.object({ type: z.literal("restaurant.patch"), input: updateOwnedRestaurantBodySchema }).strict(),
    z.object({ type: z.literal("item.create"), input: createMenuItemBodySchema }).strict(),
    z.object({ type: z.literal("item.patch"), itemId: uuid, input: updateMenuItemBodySchema }).strict(),
    z.object({ type: z.literal("item.delete"), itemId: uuid }).strict(),
    z.object({ type: z.literal("rebuild") }).strict(),
  ]),
}).strict();

// This is publication classification, not patch authorization or validation.
const publicFields = new Set([
  "name", "slug", "whatsapp", "address", "phone", "hours", "description", "primaryColor",
  "secondaryColor", "fontFamily", "logoUrl", "totalTables", "maxTables", "paymentMode",
  "maxPendingOrders", "localEnabled", "deliveryEnabled",
]);

export function affectsPublicCatalog(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some(key => publicFields.has(key) && patch[key] !== undefined);
}

export function validateCatalogCommand(input: unknown): CatalogCommand { return commandSchema.parse(input); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function allocateOnboardingRestaurantId(userId: string, operationId: string): Promise<string> {
  const bytes = (await digest(JSON.stringify(["vapt.catalog.onboarding.v1", uuid.parse(userId), uuid.parse(operationId)]))).slice(0, 16);
  // RFC 9562 custom UUIDv8; deterministic address only, never an authorization token.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function fingerprintCommand(command: CatalogCommand): Promise<string> {
  const valid = validateCatalogCommand(command);
  const hash = await digest(canonical({ protocol: "vapt.catalog.command.v1", operationId: valid.operationId,
    restaurantId: valid.restaurantId, userId: valid.actor.userId, mutation: valid.mutation }));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
