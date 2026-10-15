// Test-only HTTP/authority boundary for real browser + workerd transport proof.
// No Neon/provider/network credentials, and never imported by a deployment entry.
import { Hono } from "hono";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ExecutionContext } from "hono";
import type { ApiServices } from "../composition/api-services.js";
import { AppError } from "../lib/errors.js";
import { installWorkerHttpPolicy } from "./http.js";
import type { WorkerHonoEnv } from "./app.js";
import { registerWorkerRealtimeRoutes } from "./routes/realtime.js";
import type { RestaurantRealtime } from "./realtime/restaurant-room.js";
import type { TestRestaurantRealtime } from "./realtime-test-fixture.js";

export const browserTenants = {
  a: { restaurantId: "11111111-1111-4111-8111-111111111111", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "synthetic-a" },
  b: { restaurantId: "99999999-9999-4999-8999-999999999999", userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", slug: "synthetic-b" },
} as const;
const tenants = Object.entries(browserTenants);
const localOwner = (headers: Headers) => /(?:^|;\s*)local-owner=([ab])(?:;|$)/.exec(headers.get("cookie") ?? "")?.[1] as "a" | "b" | undefined;
export function browserRestaurant(key: "a" | "b") {
  const tenant = browserTenants[key];
  return { id: tenant.restaurantId, ownerId: tenant.userId, name: `Synthetic ${key.toUpperCase()}`, slug: tenant.slug,
    cnpj: null, whatsapp: null, address: null, phone: null, hours: null, description: null, primaryColor: "#0ea573",
    secondaryColor: "#1e293b", fontFamily: "modern", logoUrl: null, totalTables: 2, maxTables: 2, paymentMode: "open_tab",
    maxPendingOrders: 3, localEnabled: true, deliveryEnabled: true, createdAt: "2026-10-06T12:00:00.000Z", updatedAt: "2026-10-06T12:00:00.000Z" };
}
export function browserMenuItem(key: "a" | "b") {
  return { id: "10000000-0000-4000-8000-000000000001", restaurantId: browserTenants[key].restaurantId, name: "Prato sintético",
    price: "23.50", description: "Somente teste local", category: "Pratos", available: true, imageUrl: null,
    availableFrom: null, availableUntil: null, badge: null, isChefSuggestion: false, prepTimeMinutes: null,
    createdAt: "2026-10-06T12:00:00.000Z", updatedAt: "2026-10-06T12:00:00.000Z", variations: [] };
}
type Env = { ROOMS: DurableObjectNamespace<TestRestaurantRealtime> };
type BrowserRoomPort = {
  testBusiness(operation: string, body: Record<string, any>): Promise<any>;
  testControl(operation: string, body: Record<string, any>): Promise<any>;
};
export async function handleBrowserFixture(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response(null, { status: 404 });
  url.pathname = url.pathname.replace(/^\/browser/, "");
  const app = new Hono<WorkerHonoEnv>();
  const room = (key: "a" | "b"): BrowserRoomPort => env.ROOMS.getByName(browserTenants[key].restaurantId) as unknown as BrowserRoomPort;
  installWorkerHttpPolicy(app, async () => ({ realtimeAuthorization: {
    async admit(input: any) {
      if (input.mode === "owner") {
        const key = localOwner(input.headers);
        if (!key) throw new AppError(401, "unauthorized", "Unauthorized");
        const tenant = browserTenants[key];
        if (tenant.restaurantId !== input.restaurantId) throw new AppError(403, "forbidden", "Forbidden");
        return { mode: "owner", restaurantId: tenant.restaurantId, userId: tenant.userId,
          sessionId: tenant.userId, sessionExpiresAt: Date.now() + 3_600_000 };
      }
      for (const [key, tenant] of tenants) {
        const orders = await room(key as "a" | "b").testBusiness("orders", {});
        if (orders.some((order: any) => order.orderId === input.orderId) && input.token === `synthetic-public-token-${key}`)
          return { mode: "order", restaurantId: tenant.restaurantId, orderId: input.orderId, tokenFingerprint: "a".repeat(64) };
      }
      throw new AppError(404, "not_found", "Order not found");
    },
  } } as unknown as ApiServices));
  registerWorkerRealtimeRoutes(app);
  app.all("/v1/test/login/:key", c => {
    const key = c.req.param("key");
    if (!(key in browserTenants)) return c.body(null, 404);
    c.header("set-cookie", `local-owner=${key}; HttpOnly; SameSite=Lax; Path=/`);
    return c.html(`<html><body><h1>Identidade sintética ${key.toUpperCase()}</h1><p>Somente teste local, sem banco ou credenciais reais.</p><a href="http://localhost:5179/dashboard/kitchen">Abrir cozinha local</a></body></html>`);
  });
  app.post("/v1/test/orders/:key", async c => {
    const key = c.req.param("key") as "a" | "b";
    if (!(key in browserTenants)) return c.body(null, 404);
    return Response.json(await room(key).testBusiness("create", await c.req.json()), { status: 201 });
  });
  app.post("/v1/test/control/:key", async c => {
    const key = c.req.param("key") as "a" | "b";
    if (!(key in browserTenants)) return c.body(null, 404);
    return Response.json(await room(key).testBusiness("control", await c.req.json()));
  });
  app.get("/v1/test/info/:key", async c => {
    const key = c.req.param("key") as "a" | "b";
    if (!(key in browserTenants)) return c.body(null, 404);
    return c.json(await room(key).testControl("info", {}));
  });
  app.get("/v1/public/restaurants/:slug/catalog", c => {
    const key = tenants.find(([, value]) => value.slug === c.req.param("slug"))?.[0] as "a" | "b" | undefined;
    return key ? c.json({ restaurant: browserRestaurant(key), items: [browserMenuItem(key)] }) : c.body(null, 404);
  });
  app.get("/v1/public/orders/:id", async c => {
    for (const [key] of tenants) {
      if (c.req.header("x-vapt-order-token") !== `synthetic-public-token-${key}`) continue;
      const orders = await room(key as "a" | "b").testBusiness("orders", {});
      const order = orders.find((value: any) => value.orderId === c.req.param("id"));
      if (order) return c.json(order);
    }
    return c.body(null, 404);
  });
  app.post("/v1/public/orders", async c => {
    const body = await c.req.json();
    const key = tenants.find(([, value]) => value.slug === body.restaurantSlug)?.[0] as "a" | "b" | undefined;
    if (!key) return c.body(null, 404);
    const order = await room(key).testBusiness("create", body);
    return Response.json({ ...order, publicToken: `synthetic-public-token-${key}`, idempotentReplay: false }, { status: 201 });
  });
  app.all("/v1/*", async c => {
    const key = localOwner(c.req.raw.headers);
    const path = c.req.path;
    if (path.endsWith("/get-session")) return c.json(key ? { user: { id: browserTenants[key].userId,
      email: `synthetic-${key}@example.test`, name: `Synthetic ${key.toUpperCase()}`, emailVerified: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      session: { id: browserTenants[key].userId, userId: browserTenants[key].userId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } : null);
    if (path.endsWith("/sign-out")) { c.header("set-cookie", "local-owner=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return c.json({ success: true }); }
    if (!key) return c.body(null, 401);
    if (path === "/v1/restaurants/me") return c.json(browserRestaurant(key));
    if (path === "/v1/billing/stripe/subscription") return c.json({ planType: "pro", planStatus: "active", trialEndsAt: null,
      currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionCanceledAt: null, canManageBilling: false, canStartCheckout: false, requiresBillingAction: false });
    if (path === "/v1/restaurants/me/kitchen/orders") {
      const orders = await room(key).testBusiness("orders", {});
      return c.json(orders.filter((value: any) => value.status !== "delivered").map(kitchenOrder));
    }
    const statusPath = /^\/v1\/restaurants\/me\/kitchen\/orders\/([^/]+)\/status$/.exec(path);
    if (statusPath && ["PATCH", "POST"].includes(c.req.method)) {
      const value = await room(key).testBusiness("status", { ...await c.req.json(), orderId: statusPath[1] });
      return value ? c.json(kitchenOrder(value)) : c.body(null, 404);
    }
    if (path === "/v1/restaurants/me/table-sessions") {
      const orders = await room(key).testBusiness("orders", {});
      return c.json(orders.length ? [{ id: browserTenants[key].restaurantId, restaurantId: browserTenants[key].restaurantId,
        tableNumber: "1", status: "open", openedAt: orders[0].createdAt, closedAt: null, sessionTotal: (orders.length * 23.5).toFixed(2), orderCount: orders.length }] : []);
    }
    return c.body(null, 404);
  });
  const headers = new Headers(request.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "127.0.0.1");
  return app.fetch(new Request(url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit), {
    ENVIRONMENT: "preview", REALTIME_ENABLED: "true", CORS_ORIGINS: "http://127.0.0.1:5179,http://localhost:5179",
    BETTER_AUTH_SECRET: "synthetic-realtime-ingress-secret-32-characters",
    RESTAURANT_REALTIME: env.ROOMS as unknown as DurableObjectNamespace<RestaurantRealtime>,
    PUBLIC_RATE_LIMIT: { async limit() { return { success: true }; } },
  }, context);
}
function kitchenOrder(order: any) {
  return { id: order.orderId, displayId: order.displayId, restaurantId: order.restaurantId, tableNumber: "1",
    totalPrice: order.totalPrice, status: order.status, channel: order.channel, paymentStatus: order.paymentStatus,
    createdAt: order.createdAt, updatedAt: order.createdAt,
    items: [{ id: order.orderId, productName: "Prato sintético", quantity: 1, unitPrice: "23.50", notes: "" }] };
}
