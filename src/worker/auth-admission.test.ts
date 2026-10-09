import assert from "node:assert/strict";
import test from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import type { ExecutionContext } from "hono";

import type { ApiServices } from "../composition/api-services.js";
import { AppError } from "../lib/errors.js";
import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
const origin = "https://app.vapt.test";
const secret = "synthetic-admission-secret-at-least-32-characters";
const base = "https://api.vapt.test";
function bindings(allowed = true): WorkerBindings {
  return {
    ENVIRONMENT: "preview",
    CORS_ORIGINS: origin,
    AUTH_RATE_LIMIT: { async limit() { return { success: allowed }; } },
  };
}
function request(path = "/auth/me", headers: Record<string, string> = {}) {
  return new Request(base + path, { headers: { "cf-connecting-ip": "203.0.113.1", ...headers } });
}

test("anonymous private requests reject before initializing request services", async () => {
  let initializations = 0;
  const app = createWorkerApp(async () => {
    initializations++;
    throw new AppError(503, "service_unavailable", "Service unavailable");
  });
  for (const path of ["/auth/me", "/restaurants/me"]) {
    const response = await app.fetch(request(path), bindings(), execution);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "unauthorized", message: "Unauthorized" } });
    assert.equal(response.headers.get("x-ratelimit-limit"), "20");
  }
  assert.equal(initializations, 0);
});

test("legacy bearer alone cannot initialize or authorize private services", async () => {
  let initializations = 0;
  const app = createWorkerApp(async () => {
    initializations++;
    throw new AppError(503, "service_unavailable", "Service unavailable");
  });
  const response = await app.fetch(request("/auth/me", { authorization: "Bearer synthetic-legacy" }), bindings(), execution);
  assert.equal(response.status, 401);
  assert.equal(initializations, 0);
});

test("anonymous early rejection retains ingress, limiter and origin guards", async () => {
  let initializations = 0;
  const app = createWorkerApp(async () => {
    initializations++;
    throw new AppError(503, "service_unavailable", "Service unavailable");
  });
  assert.equal((await app.fetch(request(), bindings(false), execution)).status, 429);
  assert.equal((await app.fetch(request(), { ENVIRONMENT: "preview", CORS_ORIGINS: origin }, execution)).status, 503);
  assert.equal((await app.fetch(new Request(base + "/auth/me"), bindings(), execution)).status, 429);
  assert.equal((await app.fetch(request("/auth/me", { origin: "https://evil.example" }), bindings(), execution)).status, 500);
  assert.equal(initializations, 0);
});

function sessionFixture() {
  const now = new Date();
  const store = {
    user: [{ id: "user-1", name: "Owner", email: "owner@vapt.test", emailVerified: true, createdAt: now, updatedAt: now }],
    session: [{ id: "session-1", token: "synthetic-session-token", userId: "user-1",
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null }],
    account: [], verification: [],
  };
  // Real upstream cookie/signature/session validation, with only external SQL replaced.
  const auth = betterAuth({ baseURL: base, secret, trustedOrigins: [origin], database: memoryAdapter(store),
    advanced: { useSecureCookies: true } });
  let initializations = 0;
  const app = createWorkerApp(async () => {
    initializations++;
    return { authRuntime: {
      handler: auth.handler,
      async getSession(headers: Headers) { return auth.api.getSession({ headers }); },
      async close() {},
    } } as ApiServices;
  });
  const cookie = async (token = "synthetic-session-token") =>
    (await serializeSignedCookie("__Secure-better-auth.session_token", token, secret)).split(";")[0];
  return { app, store, cookie, initializations: () => initializations };
}

test("present secure session cookie still undergoes real Better Auth validation", async () => {
  const f = sessionFixture();
  const response = await f.app.fetch(request("/auth/me", { cookie: await f.cookie(), origin }), bindings(), execution);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { userId: "user-1", email: "owner@vapt.test", role: "authenticated" });
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(f.initializations(), 1);
});

test("all present cookie headers reach authoritative validation rather than presence-based approval", async () => {
  const f = sessionFixture();
  for (const cookie of ["", "analytics=synthetic", "__Secure-better-auth.session_token=invalid", await f.cookie("unknown-token")]) {
    const response = await f.app.fetch(request("/auth/me", { cookie }), bindings(), execution);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "unauthorized", message: "Unauthorized" } });
  }
  assert.equal(f.initializations(), 4);
});

test("session revocation remains authoritative on the next request", async () => {
  const f = sessionFixture();
  const cookie = await f.cookie();
  assert.equal((await f.app.fetch(request("/auth/me", { cookie }), bindings(), execution)).status, 200);
  f.store.session.splice(0);
  assert.equal((await f.app.fetch(request("/auth/me", { cookie }), bindings(), execution)).status, 401);
  assert.equal(f.initializations(), 2);
});

test("public Better Auth handler remains callable without cookies", async () => {
  const f = sessionFixture();
  const response = await f.app.fetch(request("/api/auth/get-session"), bindings(), execution);
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);
  assert.equal(f.initializations(), 1);
});
