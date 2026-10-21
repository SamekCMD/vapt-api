import type { PublicCatalogDto } from "../business/contracts.js";
import type { CreateMenuItemBody, UpdateMenuItemBody } from "../menu/schemas.js";
import type { OnboardingBody, UpdateOwnedRestaurantBody } from "../restaurants/schemas.js";

export type CatalogVersion = string;
export type CatalogState = { version: CatalogVersion; catalog: PublicCatalogDto };
export type CatalogActor = import("../tenancy/contracts.js").TenantActor;
export type CatalogMutation =
  | { type: "onboarding"; input: OnboardingBody }
  | { type: "onboarding.finalize"; input: {restaurantId:string} }
  | { type: "restaurant.patch"; input: UpdateOwnedRestaurantBody }
  | { type: "item.create"; input: CreateMenuItemBody }
  | { type: "item.patch"; itemId: string; input: UpdateMenuItemBody }
  | { type: "item.delete"; itemId: string }
  | { type: "rebuild" };
export type CatalogCommand = { operationId: string; restaurantId: string; actor: CatalogActor; mutation: CatalogMutation };
export type CommandIdentity = { operationId: string; restaurantId: string; actor: CatalogActor; fingerprint: string };
export type CommandReceipt = {
  operationId: string; restaurantId: string;
  phase: "accepted" | "committed" | "projected" | "ready" | "blocked";
  version: CatalogVersion | null; committed: boolean; retryable: boolean;
};
export type CommandOutcome<T> = { receipt: CommandReceipt; result?: T };
export type CatalogSignal = {
  protocol: "vapt.catalog.v1"; type: "ready" | "catalog_changed";
  version: CatalogVersion; canonicalSlug?: string;
};

const maxVersion = 9_223_372_036_854_775_807n;

function revision(value: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new Error("Invalid catalog revision");
  const parsed = BigInt(value);
  if (parsed > maxVersion) throw new Error("Invalid catalog revision");
  return parsed;
}

export function compareVersion(a: string, b: string): -1 | 0 | 1 {
  const left = revision(a);
  const right = revision(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function parseCatalogSignal(wire: string): CatalogSignal | null {
  try {
    if (typeof wire !== "string" || new TextEncoder().encode(wire).byteLength > 512) return null;
    const frame: unknown = JSON.parse(wire);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
    const record = frame as Record<string, unknown>;
    if (Object.keys(record).some(key => !["protocol", "type", "version", "canonicalSlug"].includes(key))) return null;
    if (record.protocol !== "vapt.catalog.v1" || !["ready", "catalog_changed"].includes(record.type as string)) return null;
    if (typeof record.version !== "string") return null;
    revision(record.version);
    if ("canonicalSlug" in record && (typeof record.canonicalSlug !== "string"
      || record.canonicalSlug.length < 2 || record.canonicalSlug.length > 60
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.canonicalSlug))) return null;
    return {
      protocol: "vapt.catalog.v1", type: record.type as CatalogSignal["type"], version: record.version,
      ...(typeof record.canonicalSlug === "string" ? { canonicalSlug: record.canonicalSlug } : {}),
    };
  } catch { return null; }
}
