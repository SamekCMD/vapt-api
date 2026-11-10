import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerErrorHandler } from "./error-handler.js";
import { registerRateLimit, type RateLimitBackend, type RateLimitGroup } from "./rate-limit.js";

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

test("default Node policies retain distinct auth, billing, orders, and webhook ceilings", async () => {
  const app = Fastify({ logger: false, trustProxy: true });
  registerErrorHandler(app);
  registerRateLimit(app);
  const groups: Array<[RateLimitGroup, number]> = [
    ["auth", 20], ["billing", 60], ["orders", 30], ["webhooks", 300],
  ];
  for (const [group] of groups) {
    app.get(`/${group}`, { config: { rateLimitGroup: group } }, async () => ({ ok: true }));
  }
  for (const [group, ceiling] of groups) {
    for (let count = 1; count <= ceiling; count += 1) {
      const response = await app.inject({ method: "GET", url: `/${group}` });
      assert.equal(response.statusCode, 200, `${group} request ${count}`);
    }
    assert.equal((await app.inject({ method: "GET", url: `/${group}` })).statusCode, 429);
  }
  await app.close();
});

test("injected rate backend denies with existing error and does not invent counters", async () => {
  const app = Fastify({ logger: false, trustProxy: true });
  registerErrorHandler(app);
  const keys: string[] = [];
  const backend: RateLimitBackend = {
    async limit(_group, actorKey) {
      keys.push(actorKey);
      return { allowed: keys.length === 1 };
    },
  };
  registerRateLimit(app, { backend });
  app.get("/auth-test", { config: { rateLimitGroup: "auth" } }, async () => ({ ok: true }));
  const headers = { "x-forwarded-for": "203.0.113.10" };
  const first = await app.inject({ method: "GET", url: "/auth-test", headers });
  const second = await app.inject({ method: "GET", url: "/auth-test", headers });
  assert.deepEqual(keys, ["auth:203.0.113.10", "auth:203.0.113.10"]);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-ratelimit-limit"], "20");
  assert.equal(first.headers["x-ratelimit-remaining"], undefined);
  assert.equal(first.headers["x-ratelimit-reset"], undefined);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "rate_limit_exceeded");
  await app.close();
});
