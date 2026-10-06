import type { Context, Hono, MiddlewareHandler } from "hono";
import { isIP } from "node:net";

import { ConfigError } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import type { AuthContext } from "../plugins/auth.js";
import { createSessionResolver } from "../modules/auth/session-resolver.js";
import type { RateLimitGroup } from "../plugins/rate-limit.js";
import type { WorkerHonoEnv } from "./app.js";
import { createWorkerRateLimitBackend } from "./rate-limit.js";
import type { WorkerServicesFactory } from "./services.js";

const allowedMethods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = "Content-Type, X-Captcha-Response, Idempotency-Key, X-Vapt-Order-Token";
const maxBodyBytes = 1_048_576;
const limits: Record<RateLimitGroup, number> = {
  auth: 20, billing: 60, orders: 30, storage: 30, webhooks: 300, public: 120,
  health: Number.MAX_SAFE_INTEGER,
};

export function installWorkerHttpPolicy(app: Hono<WorkerHonoEnv>, createServices?: WorkerServicesFactory): void {
  app.use("*", async (context, next) => {
    if (createServices) {
      let pending: ReturnType<WorkerServicesFactory> | undefined;
      context.set("getServices", () => {
        pending ??= createServices(context.env, context.executionCtx);
        return pending;
      });
    }

    const origin = context.req.header("origin");
    const allowed = origin && (context.env.CORS_ORIGINS ?? "")
      .split(",").map((value) => value.trim()).includes(origin);
    if (origin && !allowed) {
      if (context.req.path.startsWith("/v1/realtime/")) throw new AppError(403, "forbidden", "Forbidden");
      throw new AppError(500, "internal_error", "Origin not allowed");
    }

    if (origin && context.req.method === "OPTIONS") {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-credentials", "true");
      context.header("access-control-allow-methods", allowedMethods);
      context.header("access-control-allow-headers", allowedHeaders);
      context.header("vary", "Origin");
      return context.body(null, 204);
    }

    await next();
    if (context.res.status === 101) return;
    if (origin) {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-credentials", "true");
      context.header("vary", "Origin");
    }
  });

  app.notFound((context) => context.json({
    error: { code: "not_found", message: "Route not found" },
  }, 404));
  app.onError((error, context) => {
    if (error instanceof AppError) {
      const message = error.code === "internal_error" ? "Internal server error"
        : error.code === "unauthorized" ? "Unauthorized"
        : error.code === "forbidden" ? "Forbidden"
        : error.code === "invalid_request" ? "Invalid request"
        : error.code === "rate_limit_exceeded" ? "Too many requests"
        : error.message;
      return context.json({ error: { code: error.code, message } }, error.statusCode as 400);
    }
    console.error("worker_request_failed");
    return context.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });
}

export async function requireWorkerAuth(context: Context<WorkerHonoEnv>): Promise<AuthContext> {
  const getServices = context.get("getServices");
  if (!getServices) throw new AppError(503, "service_unavailable", "Service unavailable");
  const services = await getServices();
  const auth = await createSessionResolver(services.authRuntime, "fetch")(context.req.raw.headers);
  if (!auth) throw new AppError(401, "unauthorized", "Unauthorized");
  context.set("auth", auth);
  return auth;
}

export function workerRateLimit(group: RateLimitGroup): MiddlewareHandler<WorkerHonoEnv> {
  return async (context, next) => {
    if (group === "health") return next();
    const key = trustedRateLimitKey(context.req.raw.headers, group);
    let decision;
    try {
      decision = await createWorkerRateLimitBackend(context.env).limit(group, key);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new AppError(503, "service_unavailable", "Service unavailable");
      }
      throw error;
    }
    context.header("x-ratelimit-limit", String(limits[group]));
    if (!decision.allowed) throw new AppError(429, "rate_limit_exceeded", "Too many requests");
    await next();
  };
}

export function trustedRateLimitKey(headers: Headers, group: RateLimitGroup): string {
  const ip = headers.get("cf-connecting-ip")?.trim();
  if (!ip || isIP(ip) === 0) throw new AppError(429, "rate_limit_exceeded", "Too many requests");
  return `${group}:${ip}`;
}

export async function readWorkerBody(request: Request, tooLargeError = new AppError(500, "internal_error", "Internal server error")): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > maxBodyBytes) throw tooLargeError;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      throw tooLargeError;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function parseWorkerJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    if (/^text\/plain(?:\s*;|$)/i.test(contentType)) return readWorkerBody(request);
    throw new AppError(500, "internal_error", "Internal server error");
  }
  const raw = await readWorkerBody(request);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(400, "invalid_request", "Invalid request");
  }
}
