import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { buildApp } from "../../app.js";
import type { AppConfig } from "../../lib/config.js";
import type { OwnershipLookup } from "../../lib/permissions.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import { registerAuthRoutes } from "./routes.js";
import type { AuthRuntime, BetterAuthSession } from "./runtime.js";
import { createSessionResolver } from "./session-resolver.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const ownerSession: BetterAuthSession = {
  user: {
    id: ownerId,
    email: "owner@example.com",
    name: "Owner",
  },
  session: {
    id: "20000000-0000-4000-8000-000000000002",
    userId: ownerId,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  },
};

const validConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: {
      app: "app-secret",
      admin: "admin-secret",
    },
  },
  webhooks: {
    stripe: {
      signingSecret: "whsec_test",
      toleranceSeconds: 300,
    },
  },
  security: { publicOrderTokenSecret: "public-order-token-secret" },
  betterAuth: {
    secret: "better-auth-secret-at-least-32-characters",
    url: new URL("https://api.vapt.test"),
    trustedOrigins: ["https://app.vapt.test"],
    databaseUrl: "postgresql://vapt:password@db.vapt.test/vapt",
    turnstileSecretKey: "turnstile-secret-key",
    email: {
      resendApiKey: "re_test_key",
      from: "Vapt <noreply@vapt.test>",
      verifyAccountTemplate: "verify-account-template",
      resetPasswordTemplate: "reset-password-template",
    },
  },
};

function createFakeAuthRuntime(): AuthRuntime {
  return {
    async handler() {
      return new Response(null, { status: 404 });
    },
    async getSession(headers) {
      return headers.get("cookie")?.includes("better-auth.session_token=valid")
        ? ownerSession
        : null;
    },
    async close() {},
  };
}

test("protected route rejects a missing Better Auth session", async () => {
  const app = await buildApp(validConfig, { authRuntime: createFakeAuthRuntime() });

  const response = await app.inject({ method: "GET", url: "/auth/me" });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: { code: "unauthorized", message: "Unauthorized" },
  });
  await app.close();
});

test("protected route rejects an invalid Better Auth session cookie", async () => {
  const app = await buildApp(validConfig, { authRuntime: createFakeAuthRuntime() });

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: "better-auth.session_token=invalid" },
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

test("protected route exposes the authenticated Better Auth identity", async () => {
  const app = await buildApp(validConfig, { authRuntime: createFakeAuthRuntime() });

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: "better-auth.session_token=valid" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    userId: ownerId,
    email: "owner@example.com",
    role: "authenticated",
  });
  await app.close();
});

test("legacy Supabase bearer tokens are ignored without a Better Auth cookie", async () => {
  const app = await buildApp(validConfig, { authRuntime: createFakeAuthRuntime() });

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: "Bearer legacy-supabase-jwt" },
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

async function buildOwnershipTestApp(ownershipLookup: OwnershipLookup) {
  const app = Fastify({ logger: false });
  const runtime = createFakeAuthRuntime();
  registerAuthDecorator(app, createSessionResolver(runtime));
  registerErrorHandler(app);
  await registerAuthRoutes(app, validConfig, ownershipLookup);
  return app;
}

test("ownership lookup receives the UUID returned by Better Auth", async () => {
  const calls: Array<{ userId: string; restaurantId: string }> = [];
  const app = await buildOwnershipTestApp(async (input) => {
    calls.push(input);
    return true;
  });

  const response = await app.inject({
    method: "GET",
    url: "/auth/restaurants/rest-1/access",
    headers: { cookie: "better-auth.session_token=valid" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ userId: ownerId, restaurantId: "rest-1" }]);
  await app.close();
});

test("protected restaurant route remains forbidden when ownership fails", async () => {
  const app = await buildOwnershipTestApp(async () => false);

  const response = await app.inject({
    method: "GET",
    url: "/auth/restaurants/rest-2/access",
    headers: { cookie: "better-auth.session_token=valid" },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: { code: "forbidden", message: "Forbidden" },
  });
  await app.close();
});
