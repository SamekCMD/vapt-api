import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { Queryable } from "../../lib/database.js";
import type { AuthRuntime } from "../auth/runtime.js";
import type { PublicOrderRecord } from "../orders/repository.js";
import { createOrderService } from "../orders/service.js";
import { createOwnershipLookup } from "../../lib/permissions.js";

import * as module from "./authorization.js";

const restaurant = "10000000-0000-4000-8000-000000000001";
const otherRestaurant = "10000000-0000-4000-8000-000000000002";
const user = "10000000-0000-4000-8000-000000000003";
const sessionId = "10000000-0000-4000-8000-000000000004";
const orderId = "10000000-0000-4000-8000-000000000005";
const token = "synthetic-realtime-public-order-token";
const fingerprint = createHash("sha256").update(token).digest("hex");
const now = Date.parse("2026-10-05T00:00:00Z");
const expiry = Date.parse("2030-01-01T00:00:00Z");

function fixture() {
  const state = { owned: true, activeSession: true, validToken: true, unavailable: false, queries: [] as string[] };
  const database = { async query(sql: string, values: unknown[]) {
    state.queries.push(sql);
    if (state.unavailable) throw new Error("synthetic-db-secret-never-returned");
    if (sql.includes("jsonb_to_recordset")) {
      const entries = JSON.parse(values[0] as string) as Record<string, string>[];
      return { rows: entries.map(entry => ({ key: entry.key,
        allowed: entry.restaurant_id === restaurant && (sql.includes("better_auth")
          ? state.owned && state.activeSession && entry.user_id === user && entry.session_id === sessionId
          : state.validToken && entry.order_id === orderId && entry.token_fingerprint === fingerprint),
      })) };
    }
    assert.match(sql, /owner_id = \$2::uuid/);
    return { rows: [{ allowed: state.owned && values[0] === restaurant && values[1] === user }] };
  } } as unknown as Queryable;
  const runtime: AuthRuntime = {
    async handler() { return new Response(null, { status: 404 }); },
    async getSession(headers) {
      if (headers.get("cookie") !== "session=synthetic") return null;
      return { user: { id: user, email: "synthetic@vapt.test", name: "Synthetic" },
        session: { id: sessionId, userId: user, expiresAt: new Date(expiry) } };
    },
    async close() {},
  };
  const orders = createOrderService({
    async createPublicOrder() { throw new Error("not used"); },
    async findPublicOrder(id, hash) {
      if (id !== orderId || hash !== fingerprint || !state.validToken) return null;
      return { orderId, restaurantId: restaurant, displayId: "1", tableSessionId: null,
        totalPrice: "10.00", status: "pending", paymentStatus: null, idempotentReplay: false,
        channel: "local", tableNumber: null, createdAt: "2026-10-05T00:00:00Z", items: [] } satisfies PublicOrderRecord;
    },
  }, "synthetic-unused-hmac-secret");
  assert.equal(typeof module.createRealtimeAuthorization, "function", "realtime authorization must exist");
  const auth = module.createRealtimeAuthorization!({ database, authRuntime: runtime, orders,
    ownershipLookup: createOwnershipLookup(database) });
  return { state, database, auth };
}

test("realtime owner admission requires current session and restaurant ownership without persisting cookie", async () => {
  const { auth, state } = fixture();
  const headers = new Headers({ cookie: "session=synthetic" });
  const grant = await auth.admit({ mode: "owner", restaurantId: restaurant, headers });
  assert.deepEqual(grant, { mode: "owner", restaurantId: restaurant, userId: user, sessionId,
    sessionExpiresAt: expiry });
  await assert.rejects(auth.admit({ mode: "owner", restaurantId: otherRestaurant, headers }), { statusCode: 403 });
  await assert.rejects(auth.admit({ mode: "owner", restaurantId: restaurant, headers: new Headers() }), { statusCode: 401 });
  state.activeSession = false; // getSession intentionally models a stale cookie-cache result.
  await assert.rejects(auth.admit({ mode: "owner", restaurantId: restaurant, headers }), { statusCode: 401 });
  assert.doesNotMatch(JSON.stringify(grant), /synthetic|email|cookie|token/i);
});

test("realtime guest admission uses the existing token service and derives the tenant", async () => {
  const { auth } = fixture();
  const grant = await auth.admit({ mode: "order", orderId, token });
  assert.deepEqual(grant, { mode: "order", restaurantId: restaurant, orderId, tokenFingerprint: fingerprint });
  assert.equal(JSON.stringify(grant).includes(token), false);
  await assert.rejects(auth.admit({ mode: "order", orderId, token: "wrong-token" }), { statusCode: 404 });
  await assert.rejects(auth.admit({ mode: "order", orderId: otherRestaurant, token }), { statusCode: 404 });
});

test("realtime batch validation groups duplicates but never caches revocation across batches", async () => {
  const { auth, state } = fixture();
  const owner = { mode: "owner", restaurantId: restaurant, userId: user, sessionId, sessionExpiresAt: expiry } as const;
  const guest = { mode: "order", restaurantId: restaurant, orderId, tokenFingerprint: fingerprint } as const;
  assert.deepEqual(await auth.revalidate([owner, owner, guest, guest], now), [true, true, true, true]);
  assert.equal(state.queries.length, 2);
  state.activeSession = false;
  state.validToken = false;
  assert.deepEqual(await auth.revalidate([owner, guest], now), [false, false]);
  assert.equal(state.queries.length, 4);
  state.activeSession = true;
  state.validToken = true;
  state.owned = false;
  assert.deepEqual(await auth.revalidate([owner, guest], now), [false, true]);
});

test("realtime validation rejects expired and malformed grants and database outages", async () => {
  const { auth, state } = fixture();
  const owner = { mode: "owner", restaurantId: restaurant, userId: user, sessionId, sessionExpiresAt: expiry } as const;
  const guest = { mode: "order", restaurantId: restaurant, orderId, tokenFingerprint: fingerprint } as const;
  assert.deepEqual(await auth.revalidate([{ ...owner, sessionExpiresAt: now },
    { ...owner, userId: "bad" }, { ...guest, restaurantId: otherRestaurant },
    { ...guest, tokenFingerprint: "bad" }], now), [false, false, false, false]);
  state.unavailable = true;
  assert.deepEqual(await auth.revalidate([owner, guest], now), [false, false]);
});

test("standalone realtime grant validator needs only database, not session runtime or providers", async () => {
  const { database } = fixture();
  assert.equal(typeof module.createRealtimeGrantValidator, "function", "standalone validator must exist");
  const validate = module.createRealtimeGrantValidator!(database);
  assert.deepEqual(await validate([{ mode: "order", restaurantId: restaurant, orderId,
    tokenFingerprint: fingerprint }], now), [true]);
});
