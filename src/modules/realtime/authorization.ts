import { createHash } from "node:crypto";

import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { OwnershipLookup } from "../../lib/permissions.js";
import type { AuthRuntime } from "../auth/runtime.js";
import type { OrderService } from "../orders/service.js";

export type RealtimeGrant = {
  mode: "owner";
  restaurantId: string;
  userId: string;
  sessionId: string;
  sessionExpiresAt: number;
} | {
  mode: "order";
  restaurantId: string;
  orderId: string;
  tokenFingerprint: string;
};

export type RealtimeGrantValidator = (
  grants: readonly RealtimeGrant[], now: number,
) => Promise<readonly boolean[]>;

export type RealtimeAuthorization = {
  admit(input: { mode: "owner"; restaurantId: string; headers: Headers }
    | { mode: "order"; orderId: string; token: string }): Promise<RealtimeGrant>;
  revalidate: RealtimeGrantValidator;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

function eligible(grant: RealtimeGrant, now: number): boolean {
  if (!grant || !validId(grant.restaurantId)) return false;
  if (grant.mode === "owner") {
    return validId(grant.userId) && validId(grant.sessionId) &&
      Number.isSafeInteger(grant.sessionExpiresAt) && grant.sessionExpiresAt > now;
  }
  return grant.mode === "order" && validId(grant.orderId) &&
    typeof grant.tokenFingerprint === "string" && /^[0-9a-f]{64}$/.test(grant.tokenFingerprint);
}

function identityKey(grant: RealtimeGrant): string {
  return JSON.stringify(grant.mode === "owner"
    ? [grant.mode, grant.restaurantId, grant.userId, grant.sessionId]
    : [grant.mode, grant.restaurantId, grant.orderId, grant.tokenFingerprint]);
}

export function createRealtimeGrantValidator(database: Queryable): RealtimeGrantValidator {
  return async (grants, now) => {
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) return grants.map(() => false);
    const unique = new Map<string, RealtimeGrant>();
    for (const grant of grants) if (eligible(grant, now)) unique.set(identityKey(grant), grant);
    const owners: Record<string, string>[] = [];
    const orders: Record<string, string>[] = [];
    for (const [key, grant] of unique) {
      if (grant.mode === "owner") {
        owners.push({ key, restaurant_id: grant.restaurantId, user_id: grant.userId, session_id: grant.sessionId });
      } else {
        orders.push({ key, restaurant_id: grant.restaurantId, order_id: grant.orderId,
          token_fingerprint: grant.tokenFingerprint });
      }
    }
    const allowed = new Map<string, boolean>();
    try {
      if (owners.length) {
        const result = await database.query<{ key: string; allowed: boolean }>(
          `select requested.key, exists (
            select 1 from better_auth.session as session_row
            join public.restaurants as restaurant on restaurant.id = requested.restaurant_id
            where session_row.id = requested.session_id
              and session_row."userId" = requested.user_id
              and session_row."expiresAt" > $2::timestamptz
              and restaurant.owner_id = requested.user_id
          ) as allowed
          from jsonb_to_recordset($1::jsonb) as requested(
            key text, restaurant_id uuid, user_id uuid, session_id uuid
          )`,
          [JSON.stringify(owners), new Date(now).toISOString()],
        );
        for (const row of result.rows) allowed.set(row.key, row.allowed === true);
      }
      if (orders.length) {
        const result = await database.query<{ key: string; allowed: boolean }>(
          `select requested.key, exists (
            select 1 from public.orders as order_row
            where order_row.id = requested.order_id
              and order_row.restaurant_id = requested.restaurant_id
              and order_row.public_access_token_hash = requested.token_fingerprint
          ) as allowed
          from jsonb_to_recordset($1::jsonb) as requested(
            key text, restaurant_id uuid, order_id uuid, token_fingerprint text
          )`,
          [JSON.stringify(orders)],
        );
        for (const row of result.rows) allowed.set(row.key, row.allowed === true);
      }
      return grants.map((grant) => eligible(grant, now) && allowed.get(identityKey(grant)) === true);
    } catch {
      // Never forward SQL/provider error text or preserve previously valid authority.
      return grants.map(() => false);
    }
  };
}

export function createRealtimeAuthorization(dependencies: {
  database: Queryable;
  authRuntime: AuthRuntime;
  orders: OrderService;
  ownershipLookup: OwnershipLookup;
}): RealtimeAuthorization {
  const revalidate = createRealtimeGrantValidator(dependencies.database);
  return {
    revalidate,
    async admit(input) {
      if (input.mode === "owner") {
        if (!validId(input.restaurantId)) throw new AppError(400, "invalid_request", "Invalid request");
        const session = await dependencies.authRuntime.getSession(input.headers);
        if (!session || session.session.userId !== session.user.id) {
          throw new AppError(401, "unauthorized", "Unauthorized");
        }
        const grant: RealtimeGrant = {
          mode: "owner", restaurantId: input.restaurantId, userId: session.user.id,
          sessionId: session.session.id, sessionExpiresAt: session.session.expiresAt.getTime(),
        };
        if (!eligible(grant, Date.now())) throw new AppError(401, "unauthorized", "Unauthorized");
        if (!await dependencies.ownershipLookup({ userId: grant.userId, restaurantId: grant.restaurantId })) {
          throw new AppError(403, "forbidden", "Forbidden");
        }
        // Better Auth's cookie cache is not proof a session still exists in Neon.
        if (!(await revalidate([grant], Date.now()))[0]) throw new AppError(401, "unauthorized", "Unauthorized");
        return grant;
      }
      if (input.mode !== "order" || !validId(input.orderId) ||
        typeof input.token !== "string" || input.token.length === 0 || input.token.length > 256) {
        throw new AppError(400, "invalid_request", "Invalid request");
      }
      const order = await dependencies.orders.getPublicOrder(input.orderId, input.token);
      if (order.orderId !== input.orderId || !validId(order.restaurantId)) {
        throw new AppError(404, "not_found", "Order not found");
      }
      return { mode: "order", restaurantId: order.restaurantId, orderId: order.orderId,
        tokenFingerprint: createHash("sha256").update(input.token).digest("hex") };
    },
  };
}
