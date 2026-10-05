import type { DurableObjectNamespace, DurableObjectState, Request as PlatformRequest, Response as PlatformResponse } from "@cloudflare/workers-types";
import type { RealtimeGrant } from "../modules/realtime/authorization.js";
import { RestaurantRealtime, type RoomEnvironment } from "./realtime/restaurant-room.js";

type Env = RoomEnvironment & { ROOMS: DurableObjectNamespace<TestRestaurantRealtime> };
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
}
export default {
  async fetch(request: PlatformRequest, env: Env): Promise<PlatformResponse> {
    const [operation, restaurantId] = new URL(request.url).pathname.slice(1).split("/");
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
