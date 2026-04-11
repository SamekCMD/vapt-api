import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerErrorHandler } from "./error-handler.js";
import { registerRateLimit } from "./rate-limit.js";

test("auth routes enforce lower rate limits by forwarded ip", async () => {
  const app = Fastify({ logger: false, trustProxy: true });

  registerErrorHandler(app);
  registerRateLimit(app, {
    policies: {
      auth: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    },
  });

  app.get("/auth-test", { config: { rateLimitGroup: "auth" } }, async () => ({ ok: true }));

  const first = await app.inject({
    method: "GET",
    url: "/auth-test",
    headers: {
      "x-forwarded-for": "203.0.113.10",
    },
  });
  const second = await app.inject({
    method: "GET",
    url: "/auth-test",
    headers: {
      "x-forwarded-for": "203.0.113.10",
    },
  });
  const third = await app.inject({
    method: "GET",
    url: "/auth-test",
    headers: {
      "x-forwarded-for": "203.0.113.11",
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 429);
  assert.equal(third.statusCode, 200);

  await app.close();
});

test("webhook routes allow higher limits than auth routes", async () => {
  const app = Fastify({ logger: false, trustProxy: true });

  registerErrorHandler(app);
  registerRateLimit(app, {
    policies: {
      webhooks: {
        maxRequests: 2,
        windowMs: 60_000,
      },
    },
  });

  app.post("/webhook-test", { config: { rateLimitGroup: "webhooks" } }, async () => ({ ok: true }));

  const first = await app.inject({ method: "POST", url: "/webhook-test" });
  const second = await app.inject({ method: "POST", url: "/webhook-test" });
  const third = await app.inject({ method: "POST", url: "/webhook-test" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);

  await app.close();
});
