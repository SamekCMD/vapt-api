import { DurableObject } from "cloudflare:workers";
import { Pool } from "pg";
import type { DurableObjectNamespace, DurableObjectState, Request as PlatformRequest, Response as PlatformResponse, WebSocket as PlatformSocket } from "@cloudflare/workers-types";
import { createRealtimeGrantValidator, type RealtimeGrant } from "../../modules/realtime/authorization.js";
import { parseRealtimeEnvelope, realtimeTopics, type CommittedChange, type RealtimeReady } from "../../modules/realtime/contracts.js";
import { TicketStore } from "./ticket-store.js";
import { hasCapacity, leaseExpiry, parseAdmission, parseAttachment, parseControl, scope, validId,
  type Attachment, type RoomAdmission, type RealtimeTicket } from "./room-policy.js";

export type RealtimeRoomPort = {
  issueTicket(admission: RoomAdmission): Promise<RealtimeTicket>;
  publish(change: CommittedChange): Promise<{ delivered: number }>;
};
export type RoomEnvironment = {
  ENVIRONMENT: "preview" | "production";
  CORS_ORIGINS?: string;
  HYPERDRIVE?: { connectionString: string };
  RESTAURANT_REALTIME: DurableObjectNamespace<RestaurantRealtime>;
};
declare const WebSocketPair: { new(): { 0: PlatformSocket; 1: PlatformSocket } };
const reply = (status: number) => new Response(null, { status }) as unknown as PlatformResponse;

export class RestaurantRealtime extends DurableObject<RoomEnvironment> implements RealtimeRoomPort {
  protected tickets: TicketStore;
  constructor(ctx: DurableObjectState, env: RoomEnvironment) {
    super(ctx, env);
    this.tickets = new TicketStore(ctx.storage.sql, callback => ctx.storage.transactionSync(callback));
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS realtime_sequences (scope TEXT PRIMARY KEY, sequence INTEGER NOT NULL)");
    // Restore authority from platform attachments on each event, not a Map.
    // Close/send side effects belong to that event's lifetime, not construction.
  }
  protected now(): number { return Date.now(); }
  protected async validateGrants(grants: readonly RealtimeGrant[], now: number): Promise<readonly boolean[]> {
    if (!this.env.HYPERDRIVE?.connectionString) return grants.map(() => false);
    const database = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, max: 1,
      connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2000, lock_timeout: 1000 });
    try { return await createRealtimeGrantValidator(database)(grants, now); }
    finally { await database.end(); }
  }
  private async authorized(grants: readonly RealtimeGrant[]): Promise<readonly boolean[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.validateGrants(grants, this.now()), new Promise<readonly boolean[]>(resolve => {
        timer = setTimeout(() => resolve(grants.map(() => false)), 2000);
      })]);
    } catch { return grants.map(() => false); }
    finally { clearTimeout(timer); }
  }
  private belongs(restaurantId: string): boolean {
    return validId(restaurantId) && this.ctx.id.equals(this.env.RESTAURANT_REALTIME.idFromName(restaurantId));
  }
  private close(socket: PlatformSocket, code: number) {
    socket.serializeAttachment(null);
    try { socket.close(code, code === 1013 ? "Unavailable" : "Invalid connection"); } catch {}
  }
  private active(): { socket: PlatformSocket; attachment: Attachment }[] {
    const result: { socket: PlatformSocket; attachment: Attachment }[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      let attachment: Attachment | null = null;
      try { attachment = parseAttachment(socket.deserializeAttachment()); } catch {}
      if (!attachment || attachment.expiresAt <= this.now() ||
        attachment.admission.environment !== this.env.ENVIRONMENT || !this.belongs(attachment.admission.grant.restaurantId) ||
        leaseExpiry(attachment.admission.grant, this.now()) <= this.now()) {
        this.close(socket, 1008);
      } else result.push({ socket, attachment });
    }
    return result;
  }
  private sequence(key: string): number {
    return Number(this.ctx.storage.sql.exec("SELECT sequence FROM realtime_sequences WHERE scope = ?", key).toArray()[0]?.sequence ?? 0);
  }
  private nextSequence(key: string): number {
    return Number(this.ctx.storage.sql.exec("INSERT INTO realtime_sequences (scope, sequence) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET sequence = sequence + 1 RETURNING sequence", key).toArray()[0].sequence);
  }
  private async cleanup() {
    const now = this.now();
    const active = this.active();
    const scopes = new Set([...this.tickets.orderScopes(now), ...active.map(item => scope(item.attachment.admission.grant))]);
    for (const row of this.ctx.storage.sql.exec("SELECT scope FROM realtime_sequences").toArray()) {
      if (!scopes.has(String(row.scope))) this.ctx.storage.sql.exec("DELETE FROM realtime_sequences WHERE scope = ?", row.scope);
    }
    const expiries = active.map(item => item.attachment.expiresAt);
    const ticketExpiry = this.tickets.nextExpiry(now);
    if (ticketExpiry !== null) expiries.push(ticketExpiry);
    if (expiries.length) await this.ctx.storage.setAlarm(Math.min(...expiries));
    else await this.ctx.storage.deleteAlarm();
  }
  async issueTicket(input: RoomAdmission): Promise<RealtimeTicket> {
    const admission = parseAdmission(input);
    if (!admission || admission.environment !== this.env.ENVIRONMENT || !this.belongs(admission.grant.restaurantId) ||
      !this.env.CORS_ORIGINS?.split(",").map(value => value.trim()).includes(admission.origin) ||
      leaseExpiry(admission.grant, this.now()) <= this.now()) throw new Error("Invalid admission");
    if (!(await this.authorized([admission.grant]))[0] || leaseExpiry(admission.grant, this.now()) <= this.now()) throw new Error("Invalid admission");
    const ticket = await this.tickets.issue(admission, this.now());
    await this.cleanup();
    return ticket;
  }
  async fetch(request: PlatformRequest): Promise<PlatformResponse> {
    if (request.method !== "GET") return reply(405);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply(400);
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map(value => value.trim());
    if (protocols.length !== 2 || protocols.filter(value => value === "vapt.realtime.v1").length !== 1) return reply(403);
    const ticket = protocols.find(value => value.startsWith("vapt.ticket."))?.slice(12);
    const consumed = ticket ? await this.tickets.consume(ticket, this.now()) : null;
    const admission = consumed?.admission;
    if (!admission || admission.origin !== request.headers.get("Origin") || admission.environment !== this.env.ENVIRONMENT ||
      !this.belongs(admission.grant.restaurantId)) { await this.cleanup(); return reply(403); }
    if (!(await this.authorized([admission.grant]))[0] || consumed!.expiresAt <= this.now() || leaseExpiry(admission.grant, this.now()) <= this.now()) {
      await this.cleanup(); return reply(403);
    }
    const active = this.active();
    if (!hasCapacity(active.map(item => item.attachment.admission.grant), admission.grant)) {
      await this.cleanup(); return reply(503);
    }
    const pair = new WebSocketPair();
    const current = this.sequence(scope(admission.grant));
    const attachment: Attachment = { version: 1, admission, expiresAt: leaseExpiry(admission.grant, this.now()), lastSent: current, lastAck: current };
    pair[1].serializeAttachment(attachment);
    this.ctx.acceptWebSocket(pair[1]);
    const ready: RealtimeReady = { version: 1, type: "ready", leaseExpiresAt: attachment.expiresAt };
    pair[1].send(JSON.stringify(ready));
    await this.cleanup();
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": "vapt.realtime.v1" } } as ResponseInit) as unknown as PlatformResponse;
  }
  async publish(change: CommittedChange): Promise<{ delivered: number }> {
    if (!this.belongs(change.restaurantId) || !Array.isArray(change.topics) || !Array.isArray(change.orderIds) ||
      !change.orderIds.every(validId) || !change.topics.every(topic => realtimeTopics.includes(topic)) ||
      !parseRealtimeEnvelope({ version: 1, eventId: crypto.randomUUID(), sequence: 0, topic: change.topics[0], entityId: change.entityId, reason: change.reason })) {
      throw new Error("Invalid change");
    }
    const snapshot = this.active();
    const allowed = await this.authorized(snapshot.map(item => item.attachment.admission.grant));
    const valid: typeof snapshot = [];
    snapshot.forEach((item, index) => {
      const restored = parseAttachment(item.socket.deserializeAttachment());
      if (!allowed[index] || !restored || restored.expiresAt <= this.now()) this.close(item.socket, 1008);
      else valid.push({ socket: item.socket, attachment: restored });
    });
    let delivered = 0;
    const sequences = new Map<string, number>();
    const eventIds = new Map<string, string>();
    for (const { socket, attachment } of valid) {
      const grant = attachment.admission.grant;
      const topics = grant.mode === "owner" ? [...new Set(change.topics)] :
        change.orderIds.includes(grant.orderId) ? ["orders" as const] : [];
      for (const topic of topics) {
        if (attachment.lastSent - attachment.lastAck >= 32) { this.close(socket, 1013); break; }
        const key = `${scope(grant)}:${topic}`;
        if (!sequences.has(key)) {
          sequences.set(key, this.nextSequence(scope(grant)));
          eventIds.set(key, crypto.randomUUID());
        }
        const envelope = { version: 1, eventId: eventIds.get(key), sequence: sequences.get(key)!, topic,
          entityId: grant.mode === "owner" ? change.entityId : grant.orderId, reason: change.reason };
        const encoded = JSON.stringify(envelope);
        if (new TextEncoder().encode(encoded).byteLength > 4096) { this.close(socket, 1013); break; }
        try {
          socket.send(encoded);
          attachment.lastSent = envelope.sequence;
          socket.serializeAttachment(attachment);
          delivered++;
        } catch { this.close(socket, 1013); break; }
      }
    }
    await this.cleanup();
    return { delivered };
  }
  async alarm(): Promise<void> { await this.cleanup(); }
  async webSocketMessage(socket: PlatformSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.active().find(item => item.socket === socket)?.attachment;
    if (!attachment) return;
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (bytes > 4096) this.close(socket, 1009);
    else {
      const control = parseControl(message, attachment.lastAck, attachment.lastSent);
      if (!control) this.close(socket, 1008);
      else if (control.type === "ack") { attachment.lastAck = control.sequence; socket.serializeAttachment(attachment); }
      else { try { socket.send('{"version":1,"type":"pong"}'); } catch { this.close(socket, 1013); } }
    }
    await this.cleanup();
  }
  async webSocketClose(socket: PlatformSocket, code: number): Promise<void> {
    socket.serializeAttachment(null);
    try { socket.close(code); } catch {}
    await this.cleanup();
  }
  async webSocketError(socket: PlatformSocket): Promise<void> { this.close(socket, 1013); await this.cleanup(); }
}
