import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import { registerMenuImageRoutes } from "./routes.js";
import type { MenuImageService } from "./service.js";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const itemId = "20000000-0000-4000-8000-000000000002";

const config = {
  nodeEnv: "test",
  supabase: { jwtSecret: "jwt-secret" },
} as AppConfig;

function createToken() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    sub: "user-1",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const signature = createHmac("sha256", config.supabase.jwtSecret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

async function createApp(service: MenuImageService) {
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerMenuImageRoutes(app, config, service);
  return app;
}

test("authenticated owner can request a scoped menu image upload", async () => {
  const calls: unknown[] = [];
  const service: MenuImageService = {
    async prepareUpload(input) {
      calls.push(input);
      return {
        method: "PUT",
        uploadUrl: "https://signed.example.com/upload",
        publicUrl: `https://assets.vapt.app.br/${restaurantId}/${itemId}`,
        objectKey: `${restaurantId}/${itemId}`,
        headers: { "Content-Type": "image/jpeg" },
        expiresInSeconds: 300,
      };
    },
    async delete() {},
  };
  const app = await createApp(service);

  const response = await app.inject({
    method: "POST",
    url: `/restaurants/${restaurantId}/menu-items/${itemId}/image/upload`,
    headers: { authorization: `Bearer ${createToken()}` },
    payload: { contentType: "image/jpeg", contentLength: 1234 },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().objectKey, `${restaurantId}/${itemId}`);
  assert.deepEqual(calls, [{
    userId: "user-1",
    restaurantId,
    itemId,
    contentType: "image/jpeg",
    contentLength: 1234,
  }]);
  await app.close();
});

test("menu image upload rejects unsupported or oversized files before signing", async () => {
  let calls = 0;
  const service: MenuImageService = {
    async prepareUpload() {
      calls += 1;
      throw new Error("should not run");
    },
    async delete() {},
  };
  const app = await createApp(service);

  for (const payload of [
    { contentType: "image/svg+xml", contentLength: 100 },
    { contentType: "image/jpeg", contentLength: 5 * 1024 * 1024 + 1 },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/restaurants/${restaurantId}/menu-items/${itemId}/image/upload`,
      headers: { authorization: `Bearer ${createToken()}` },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_request");
  }
  assert.equal(calls, 0);
  await app.close();
});

test("menu image delete requires authentication and returns no content", async () => {
  const deleted: unknown[] = [];
  const service: MenuImageService = {
    async prepareUpload() {
      throw new Error("not used");
    },
    async delete(input) {
      deleted.push(input);
    },
  };
  const app = await createApp(service);
  const route = `/restaurants/${restaurantId}/menu-items/${itemId}/image`;

  const unauthorized = await app.inject({ method: "DELETE", url: route });
  assert.equal(unauthorized.statusCode, 401);

  const response = await app.inject({
    method: "DELETE",
    url: route,
    headers: { authorization: `Bearer ${createToken()}` },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(deleted, [{ userId: "user-1", restaurantId, itemId }]);
  await app.close();
});
