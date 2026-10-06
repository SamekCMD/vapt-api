import type { DurableObjectNamespace, DurableObjectState, Request as PlatformRequest, Response as PlatformResponse } from "@cloudflare/workers-types";
import type { RealtimeGrant } from "../modules/realtime/authorization.js";
import { RestaurantRealtime, type RoomEnvironment } from "./realtime/restaurant-room.js";
import { createWorkerApp } from "./app.js";
import { handleParallelPreview } from "./parallel-preview.js";
import { AppError } from "../lib/errors.js";
import type { ApiServices } from "../composition/api-services.js";
import type { WorkerBindings } from "./environment.js";
import type { ExecutionContext } from "hono";
import { browserTenants, handleBrowserFixture } from "./realtime-browser-fixture.js";

type Env = RoomEnvironment & { ROOMS: DurableObjectNamespace<TestRestaurantRealtime> };
const restaurantId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const app = createWorkerApp(async () => ({ realtimeAuthorization: {
  async admit(input: { mode: "owner"; restaurantId: string; headers: Headers } | { mode: "order"; orderId: string; token: string }) {
    if (input.mode === "owner") {
      if (input.headers.get("authorization")) throw new Error("Operator header must be removed");
      if (input.headers.get("cookie") !== "session=owner") throw new AppError(401, "unauthorized", "Unauthorized");
      if (input.restaurantId !== restaurantId) throw new AppError(403, "forbidden", "Forbidden");
      return { mode: "owner", restaurantId, userId: orderId, sessionId: orderId, sessionExpiresAt: Date.now() + 300_000 };
    }
    if (input.orderId !== orderId || input.token !== "synthetic-public-token") throw new AppError(404, "not_found", "Order not found");
    return { mode: "order", restaurantId, orderId, tokenFingerprint: "a".repeat(64) };
  },
} } as unknown as ApiServices));
export class TestRestaurantRealtime extends RestaurantRealtime {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, RESTAURANT_REALTIME: env.ROOMS as unknown as DurableObjectNamespace<RestaurantRealtime> });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT INTO test_state VALUES ('constructors', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1");
  }
  protected now(): number {
    try { return Date.now() + Number(this.ctx.storage.sql.exec("SELECT value FROM test_state WHERE key = 'offset'").toArray()[0]?.value ?? 0); }
    catch { return Date.now(); }
  }
  protected async validateGrants(grants: readonly RealtimeGrant[]): Promise<readonly boolean[]> {
    const state = (key: string) => Number(this.ctx.storage.sql.exec("SELECT value FROM test_state WHERE key = ?", key).toArray()[0]?.value ?? 0);
    const advance = state("validationAdvance");
    if (advance) {
      this.ctx.storage.sql.exec("INSERT INTO test_state VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value", advance);
      this.ctx.storage.sql.exec("DELETE FROM test_state WHERE key = 'validationAdvance'");
    }
    if (state("validationDelay")) await new Promise(resolve => setTimeout(resolve, state("validationDelay")));
    if (state("unavailable")) throw new Error("Synthetic unavailable authority");
    return grants.map(grant => !this.ctx.storage.sql.exec("SELECT value FROM test_state WHERE key = ? AND value = 1",
      `revoked:${grant.mode === "owner" ? grant.userId : grant.orderId}`).toArray().length);
  }
  async testControl(operation: string, body: Record<string, any>) {
    if (operation === "authority") for (const key of ["validationAdvance", "validationDelay", "unavailable"]) {
      if (key in body) this.ctx.storage.sql.exec("INSERT INTO test_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, body[key]);
    }
    if (operation === "revoke") this.ctx.storage.sql.exec("INSERT INTO test_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `revoked:${body.orderId}`, body.revoked === false ? 0 : 1);
    if (operation === "advance") this.ctx.storage.sql.exec("INSERT INTO test_state VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value", body.milliseconds);
    if (operation === "corrupt") for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.admission?.grant?.orderId === body.orderId) socket.serializeAttachment({ version: 9000 });
    }
    if (operation === "alarm") await this.alarm();
    return {
      constructors: this.ctx.storage.sql.exec("SELECT value FROM test_state WHERE key = 'constructors'").toArray()[0].value,
      tickets: this.tickets.count(this.now()),
      sockets: this.ctx.getWebSockets().filter(socket => socket.deserializeAttachment() !== null).length,
      rawSockets: this.ctx.getWebSockets().length,
      sequences: this.ctx.storage.sql.exec("SELECT count(*) AS count FROM realtime_sequences").toArray()[0].count,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  async testBusiness(operation: string, body: Record<string, any>): Promise<any> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS browser_fixture (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const rows = this.ctx.storage.sql.exec("SELECT value FROM browser_fixture WHERE key = 'orders'").toArray();
    const orders = rows.length ? JSON.parse(String(rows[0].value)) as any[] : [];
    if (operation === "orders") return orders;
    if (operation === "control") {
      if (body.disconnect) for (const socket of this.ctx.getWebSockets()) socket.close(1012, "Synthetic restart");
      if (body.clear) {
        this.ctx.storage.sql.exec("DELETE FROM browser_fixture WHERE key = 'orders'");
        return { orders: 0 };
      }
      return { orders: orders.length };
    }
    let changed: any;
    if (operation === "create") {
      const tenant = Object.values(browserTenants).find(value => this.env.RESTAURANT_REALTIME!.idFromName(value.restaurantId).equals(this.ctx.id));
      if (!tenant) throw new Error("Unknown synthetic tenant");
      changed = { orderId: crypto.randomUUID(), restaurantId: tenant.restaurantId, displayId: String(orders.length + 1),
        tableSessionId: tenant.restaurantId, status: body.status ?? "pending", paymentStatus: "paid", channel: body.channel ?? "local",
        tableNumber: "1", totalPrice: "23.50", createdAt: new Date().toISOString(), items: [{ menuItemId: "10000000-0000-4000-8000-000000000001",
          name: "Prato sintético", quantity: 1, unitPrice: "23.50", notes: null }] };
      orders.push(changed);
    } else if (operation === "status") {
      changed = orders.find(value => value.orderId === body.orderId);
      if (!changed) return null;
      changed.status = body.status;
    } else throw new Error("Unknown synthetic operation");
    this.ctx.storage.sql.exec("INSERT INTO browser_fixture VALUES ('orders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(orders));
    if (!body.silent) await this.publish({ restaurantId: changed.restaurantId, orderIds: [changed.orderId],
      topics: ["orders", "kitchen", "table_sessions"], entityId: changed.orderId, reason: operation === "create" ? "created" : "updated" });
    return changed;
  }
}
export default {
  async fetch(request: PlatformRequest, env: Env, context: ExecutionContext): Promise<PlatformResponse> {
    if (new URL(request.url).pathname.startsWith("/browser/")) return await handleBrowserFixture(request as unknown as Request, env, context) as unknown as PlatformResponse;
    const [operation, restaurantId] = new URL(request.url).pathname.slice(1).split("/");
    if (operation.startsWith("operator")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/operator[^/]*\//, "/");
      const bindings: WorkerBindings & { PARALLEL_PREVIEW_TOKEN: string } = {
        ENVIRONMENT: env.ENVIRONMENT, CORS_ORIGINS: env.CORS_ORIGINS,
        PARALLEL_PREVIEW_TOKEN: "synthetic-operator-bearer-32-characters",
        REALTIME_ENABLED: operation === "operator-off" ? "false" : "true",
        RESTAURANT_REALTIME: operation === "operator-unbound" ? undefined : env.ROOMS as unknown as DurableObjectNamespace<RestaurantRealtime>,
        PUBLIC_RATE_LIMIT: operation === "operator-unlimited" ? undefined : { async limit() { return { success: true }; } },
      };
      return await handleParallelPreview(new Request(url, request as unknown as Request), bindings, context,
        (forwarded, scopedEnv, ctx) => app.fetch(forwarded, scopedEnv, ctx)) as unknown as PlatformResponse;
    }
    const room = env.ROOMS.getByName(restaurantId);
    if (operation === "socket") return room.fetch(request);
    try {
      const body = await request.json() as any;
      const result = operation === "issue" ? await room.issueTicket(body) : operation === "publish" ?
        await room.publish(body) : await room.testControl(operation, body);
      return Response.json(result) as unknown as PlatformResponse;
    } catch { return new Response(null, { status: 503 }) as unknown as PlatformResponse; }
  },
};
