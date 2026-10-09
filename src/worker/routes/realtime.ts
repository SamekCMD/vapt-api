import type { Hono, MiddlewareHandler } from "hono";
import { AppError } from "../../lib/errors.js";
import { isRealtimeEnabled } from "../../modules/realtime/contracts.js";
import type { WorkerHonoEnv } from "../app.js";
import { readWorkerBody, workerRateLimit } from "../http.js";
import { validId } from "../realtime/room-policy.js";
import { hasIngressKey, signIngressTicket, verifyIngressTicket } from "../realtime/ingress-ticket.js";

const unavailable = () => new AppError(503, "service_unavailable", "Service unavailable");
const invalid = () => new AppError(400, "invalid_request", "Invalid request");
const admissionGate: MiddlewareHandler<WorkerHonoEnv> = async (context, next) => {
  if (!isRealtimeEnabled(context.env.REALTIME_ENABLED) || !context.env.RESTAURANT_REALTIME || !hasIngressKey(context.env.BETTER_AUTH_SECRET)) throw unavailable();
  const origin = context.req.header("Origin");
  let exact = false;
  try { exact = !!origin && new URL(origin).origin === origin && ["https:", "http:"].includes(new URL(origin).protocol); } catch {}
  if (!exact || !(context.env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).includes(origin!)) {
    throw new AppError(403, "forbidden", "Forbidden");
  }
  await next();
};
export function registerWorkerRealtimeRoutes(app: Hono<WorkerHonoEnv>): void {
  app.post("/v1/realtime/tickets", admissionGate, workerRateLimit("public"), async context => {
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("Content-Type") ?? "")) throw invalid();
    const encoded = await readWorkerBody(context.req.raw, invalid());
    if (new TextEncoder().encode(encoded).byteLength > 4096) throw invalid();
    let body: unknown;
    try { body = JSON.parse(encoded); } catch { throw invalid(); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
    const value = body as Record<string, unknown>;
    const keys = Object.keys(value);
    let input: { mode: "owner"; restaurantId: string; headers: Headers } | { mode: "order"; orderId: string; token: string };
    if (value.mode === "owner" && keys.length === 2 && validId(value.restaurantId)) {
      input = { mode: "owner", restaurantId: value.restaurantId.toLowerCase(), headers: context.req.raw.headers };
    } else if (value.mode === "order" && keys.length === 2 && validId(value.orderId)) {
      const token = context.req.header("X-Vapt-Order-Token");
      if (!token || token.length > 256) throw invalid();
      input = { mode: "order", orderId: value.orderId.toLowerCase(), token };
    } else throw invalid();
    const services = await context.get("getServices")();
    const grant = await services.realtimeAuthorization.admit(input);
    let ticket;
    try {
      ticket = await context.env.RESTAURANT_REALTIME!.getByName(grant.restaurantId).issueTicket({
        environment: context.env.ENVIRONMENT, origin: context.req.header("Origin")!, grant,
      });
    } catch { throw unavailable(); }
    context.header("Cache-Control", "no-store");
    try {
      return context.json({ ...ticket, ticket: signIngressTicket(ticket, {
        environment: context.env.ENVIRONMENT, origin: context.req.header("Origin")!, restaurantId: grant.restaurantId,
      }, context.env.BETTER_AUTH_SECRET, Date.now()) });
    } catch { throw unavailable(); }
  });
  app.get("/v1/realtime/restaurants/:restaurantId/socket", admissionGate, workerRateLimit("public"), async context => {
    const restaurantId = context.req.param("restaurantId");
    if (!validId(restaurantId) || context.req.header("Upgrade")?.toLowerCase() !== "websocket" ||
      new URL(context.req.url).search !== "") throw invalid();
    const rawTicket = verifyIngressTicket(context.req.header("Sec-WebSocket-Protocol"), {
      environment: context.env.ENVIRONMENT, origin: context.req.header("Origin")!, restaurantId: restaurantId.toLowerCase(),
    }, context.env.BETTER_AUTH_SECRET, Date.now());
    if (!rawTicket) throw new AppError(403, "forbidden", "Forbidden");
    const headers = new Headers(context.req.raw.headers);
    headers.set("Sec-WebSocket-Protocol", `vapt.realtime.v1, vapt.ticket.${rawTicket}`);
    const admittedRequest = new Request(context.req.raw, { headers });
    try {
      // Return the original 101, not a body/headers reconstruction.
      return await context.env.RESTAURANT_REALTIME!.getByName(restaurantId.toLowerCase())
        .fetch(admittedRequest as unknown as import("@cloudflare/workers-types").Request) as unknown as Response;
    } catch { throw unavailable(); }
  });
}
