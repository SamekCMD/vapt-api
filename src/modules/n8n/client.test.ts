import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../../lib/config.js";
import { createN8nClient } from "./client.js";
import { n8nContracts } from "./contracts.js";
import { N8nClientError } from "./errors.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 100,
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

function getPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected server to be bound to an AddressInfo instance");
  }

  return (address as AddressInfo).port;
}

test("n8n route catalog covers all approved operations", () => {
  assert.deepEqual(Object.keys(n8nContracts).sort(), [
    "asaas.webhookForward",
    "ingest.orderFeedback",
    "ingest.pushSubscription",
    "stripe.health",
    "stripe.subscriptionCancel",
    "stripe.subscriptionChange",
    "stripe.subscriptionCreate",
    "stripe.subscriptionStatus",
    "stripe.webhookForward",
  ]);
});

test("client sends x-vapt-app-key for app routes", async () => {
  let receivedHeader = "";
  let receivedMethod = "";
  let receivedPath = "";
  let receivedBody = "";

  const server = createServer((request, response) => {
    receivedHeader = String(request.headers["x-vapt-app-key"] ?? "");
    receivedMethod = request.method ?? "";
    receivedPath = request.url ?? "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = getPort(server);

  const client = createN8nClient({
    ...baseConfig,
    n8n: {
      ...baseConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${port}/webhook`),
      timeoutMs: 500,
    },
  });

  const result = await client.call("stripe.subscriptionCreate", {
    body: { restaurant_id: "rest_123" },
  });

  assert.equal(receivedHeader, "app-secret");
  assert.equal(receivedMethod, "POST");
  assert.equal(receivedPath, "/webhook/stripe/subscription/create");
  assert.deepEqual(JSON.parse(receivedBody), { restaurant_id: "rest_123" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true });

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("client forwards provider webhook without internal auth headers", async () => {
  let receivedSignature = "";
  let receivedAppHeader = "";
  let receivedPath = "";
  let receivedBody = "";

  const server = createServer((request, response) => {
    receivedSignature = String(request.headers["stripe-signature"] ?? "");
    receivedAppHeader = String(request.headers["x-vapt-app-key"] ?? "");
    receivedPath = request.url ?? "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ received: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = getPort(server);

  const client = createN8nClient({
    ...baseConfig,
    n8n: {
      ...baseConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${port}/webhook`),
      timeoutMs: 500,
    },
  });

  await client.stripe.forwardWebhook({
    rawBody: '{"id":"evt_123"}',
    signatureHeader: "t=123,v1=testsig",
  });

  assert.equal(receivedSignature, "t=123,v1=testsig");
  assert.equal(receivedAppHeader, "");
  assert.equal(receivedPath, "/webhook/stripe/webhook");
  assert.equal(receivedBody, '{"id":"evt_123"}');

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("client times out slow upstream requests", async () => {
  const server = createServer((_request, _response) => {
    // Intentionally keep the connection open past the timeout window.
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = getPort(server);

  const client = createN8nClient({
    ...baseConfig,
    n8n: {
      ...baseConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      timeoutMs: 50,
    },
  });

  await assert.rejects(
    () => client.call("stripe.health"),
    (error: unknown) =>
      error instanceof N8nClientError && error.code === "upstream_timeout",
  );

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("client normalizes upstream non-2xx responses", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 502;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "bad_gateway" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = getPort(server);

  const client = createN8nClient({
    ...baseConfig,
    n8n: {
      ...baseConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      timeoutMs: 500,
    },
  });

  await assert.rejects(
    () => client.call("stripe.health"),
    (error: unknown) =>
      error instanceof N8nClientError &&
      error.code === "upstream_error" &&
      error.upstreamStatus === 502,
  );

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("client rejects invalid upstream json responses", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{invalid");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = getPort(server);

  const client = createN8nClient({
    ...baseConfig,
    n8n: {
      ...baseConfig.n8n,
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      timeoutMs: 500,
    },
  });

  await assert.rejects(
    () => client.call("stripe.health"),
    (error: unknown) =>
      error instanceof N8nClientError && error.code === "invalid_upstream_response",
  );

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
