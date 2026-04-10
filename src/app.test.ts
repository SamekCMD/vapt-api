import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "./app.js";

test("GET /health returns ok", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});

test("GET /health/ready returns ready", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready" });

  await app.close();
});
