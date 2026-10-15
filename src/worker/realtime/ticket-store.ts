import type { RoomAdmission, RealtimeTicket } from "./room-policy.js";
import { parseAdmission } from "./room-policy.js";
import { createHash } from "node:crypto";

export type RoomSql = { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");
export class TicketStore {
  constructor(private sql: RoomSql, private transaction: <T>(callback: () => T) => T) {
    sql.exec("CREATE TABLE IF NOT EXISTS realtime_tickets (hash TEXT PRIMARY KEY, admission TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }
  prune(now: number) { this.sql.exec("DELETE FROM realtime_tickets WHERE expires_at <= ?", now); }
  count(now: number): number {
    this.prune(now);
    return Number(this.sql.exec("SELECT count(*) AS count FROM realtime_tickets").toArray()[0].count);
  }
  async issue(admission: RoomAdmission, now: number): Promise<RealtimeTicket> {
    const random = crypto.getRandomValues(new Uint8Array(32));
    const ticket = btoa(String.fromCharCode(...random)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const digest = hash(ticket);
    const expiresAt = now + 30_000;
    this.transaction(() => {
      if (this.count(now) >= 256) throw new Error("Ticket capacity exceeded");
      this.sql.exec("INSERT INTO realtime_tickets (hash, admission, expires_at) VALUES (?, ?, ?)", digest, JSON.stringify(admission), expiresAt);
    });
    return { ticket, restaurantId: admission.grant.restaurantId, expiresAt };
  }
  async consume(ticket: string, now: number): Promise<{ admission: RoomAdmission; expiresAt: number } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const digest = hash(ticket);
    return this.transaction(() => {
      this.prune(now);
      const row = this.sql.exec("DELETE FROM realtime_tickets WHERE hash = ? RETURNING admission, expires_at", digest).toArray()[0];
      if (!row) return null;
      try {
        const admission = parseAdmission(JSON.parse(String(row.admission)));
        return admission ? { admission, expiresAt: Number(row.expires_at) } : null;
      } catch { return null; }
    });
  }
  nextExpiry(now: number): number | null {
    this.prune(now);
    const row = this.sql.exec("SELECT min(expires_at) AS expiry FROM realtime_tickets").toArray()[0];
    return row.expiry === null ? null : Number(row.expiry);
  }
  orderScopes(now: number): string[] {
    this.prune(now);
    const orders = new Set<string>();
    for (const row of this.sql.exec("SELECT admission FROM realtime_tickets").toArray()) {
      try {
        const admission = parseAdmission(JSON.parse(String(row.admission)));
        if (admission?.grant.mode === "order") orders.add(admission.grant.orderId);
      } catch {}
    }
    return [...orders];
  }
}
