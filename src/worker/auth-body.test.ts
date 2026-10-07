import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext } from "hono";

import type { ApiServices } from "../composition/api-services.js";
import { AppError } from "../lib/errors.js";
import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
const base = "https://api.vapt.test/api/auth/sign-in/email?test=body";
const env: WorkerBindings = { ENVIRONMENT: "preview", CORS_ORIGINS: "https://app.vapt.test",
  AUTH_RATE_LIMIT: { async limit() { return { success: true }; } } };
function request(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(base, { method: "POST", body, duplex: "half", headers: {
    "cf-connecting-ip": "203.0.113.1", "content-type": "application/json", ...headers,
  } } as RequestInit);
}
function blockedServices() {
  let calls = 0;
  const app = createWorkerApp(async () => {
    calls++;
    throw new AppError(503, "service_unavailable", "Service unavailable");
  });
  return { app, calls: () => calls };
}

// Removing the admission cap must let these bodies initialize services (503),
// rather than reject them (413) before SQL/auth/CAPTCHA/provider work.
for (const [label, headers] of [
  ["declared oversized", { "content-length": "1048577" }],
  ["without content length", {}],
  ["lying content length", { "content-length": "1" }],
] as const) {
  test(`auth rejects ${label} body before creating services`, async () => {
    const f = blockedServices();
    const response = await f.app.fetch(request("x".repeat(1_048_577), headers), env, execution);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: { code: "payload_too_large", message: "Payload too large" } });
    assert.equal(f.calls(), 0);
    assert.equal(response.headers.get("x-ratelimit-limit"), "20");
  });
}

test("auth counts UTF8 bytes rather than characters", async () => {
  const f = blockedServices();
  const response = await f.app.fetch(request("é".repeat(524_289)), env, execution);
  assert.equal(response.status, 413);
  assert.equal(f.calls(), 0);
});

test("auth cancels an overflowing chunked stream before services", async () => {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(262_144)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const f = blockedServices();
  const response = await f.app.fetch(request(stream), env, execution);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(chunks, 5);
  assert.equal(f.calls(), 0);
});

test("auth retains rate and CORS rejection before body consumption", async () => {
  let pulls = 0;
  const f = blockedServices();
  for (const [headers, bindings, expected] of [
    [{}, { ...env, AUTH_RATE_LIMIT: { async limit() { return { success: false }; } } }, 429],
    [{ origin: "https://evil.example" }, env, 500],
  ] as const) {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++; controller.enqueue(new Uint8Array(1_048_577)); controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.app.fetch(request(stream, headers), bindings, execution);
    assert.equal(response.status, expected);
  }
  assert.equal(pulls, 0);
  assert.equal(f.calls(), 0);
});

test("auth forwards exact boundary bytes and retains request metadata and cookies", async () => {
  // Only external auth services are replaced: test the real route's handoff.
  const app = createWorkerApp(async () => ({ authRuntime: {
    async handler(input: Request) {
      const bytes = await input.arrayBuffer();
      return Response.json({ length: bytes.byteLength, method: input.method, url: input.url,
        captcha: input.headers.get("x-captcha-response"), cookie: input.headers.get("cookie"),
        origin: input.headers.get("origin"), contentType: input.headers.get("content-type"),
        firstByte: new Uint8Array(bytes)[0], lastByte: new Uint8Array(bytes).at(-1) },
      { headers: { "set-cookie": "synthetic=value; HttpOnly; Secure; SameSite=Lax" } });
    },
  } } as ApiServices));
  const response = await app.fetch(request("é".repeat(524_288), {
    "x-captcha-response": "synthetic-challenge", cookie: "synthetic=value", origin: "https://app.vapt.test",
  }), env, execution);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { length: 1_048_576, method: "POST", url: base,
    captcha: "synthetic-challenge", cookie: "synthetic=value", origin: "https://app.vapt.test",
    contentType: "application/json", firstByte: 195, lastByte: 169 });
  assert.equal(response.headers.get("set-cookie"), "synthetic=value; HttpOnly; Secure; SameSite=Lax");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.vapt.test");
});

test("auth GET stays body-free and keeps the original Request", async () => {
  const input = new Request(base, { headers: { "cf-connecting-ip": "203.0.113.1" } });
  const app = createWorkerApp(async () => ({ authRuntime: {
    async handler(received: Request) { assert.equal(received, input); return new Response("get-handler"); },
  } } as ApiServices));
  const response = await app.fetch(input, env, execution);
  assert.equal(await response.text(), "get-handler");
});
