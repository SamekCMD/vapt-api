import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import { buildApp } from "../../app.js";

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
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
};

function createToken(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

const validOwnerToken = createToken(
  {
    sub: "user-1",
    email: "owner@example.com",
    role: "authenticated",
    iss: "https://supabase.example.com/auth/v1",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  validConfig.supabase.jwtSecret,
);

test("protected route rejects missing bearer token", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: {
      code: "unauthorized",
      message: "Unauthorized",
    },
  });

  await app.close();
});

test("protected route rejects invalid bearer token", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: {
      authorization: "Bearer invalid-token",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: {
      code: "unauthorized",
      message: "Unauthorized",
    },
  });

  await app.close();
});

test("protected route accepts valid token and exposes request auth", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    userId: "user-1",
    email: "owner@example.com",
    role: "authenticated",
  });

  await app.close();
});

test("protected restaurant route returns 403 when user cannot access restaurant", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/auth/restaurants/rest-2/access",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: {
      code: "forbidden",
      message: "Forbidden",
    },
  });

  await app.close();
});

test("protected restaurant route returns 200 for an active restaurant member", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/auth/restaurants/rest-1/access",
    headers: {
      authorization: `Bearer ${validOwnerToken}`,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    allowed: true,
    restaurantId: "rest-1",
    userId: "user-1",
  });

  await app.close();
});
