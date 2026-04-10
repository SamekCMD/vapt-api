import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./lib/config.js";
import { buildApp } from "./app.js";

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
      webhookSetup: "setup-secret",
      admin: "admin-secret",
    },
  },
};

test("GET /health returns ok", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});

test("GET /health/ready returns ready", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready" });

  await app.close();
});

test("unknown routes return standardized not_found errors", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/missing",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: "not_found",
      message: "Route not found",
    },
  });

  await app.close();
});

test("allowed CORS origin is echoed back", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "http://localhost:5173",
    },
  });

  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");

  await app.close();
});

test("blocked CORS origin is rejected", async () => {
  const app = await buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "https://evil.example.com",
    },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });

  await app.close();
});
