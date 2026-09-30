import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { ExecutionContext } from "hono";

import type { WorkerBindings } from "./environment.js";
import { handleParallelPreview } from "./parallel-preview.js";

const secret = randomBytes(32).toString("hex");
const context = {} as ExecutionContext;
const env: WorkerBindings & { PARALLEL_PREVIEW_TOKEN?: string } = {
  ENVIRONMENT: "preview",
  PARALLEL_PREVIEW_TOKEN: secret,
};

function request(authorization?: string): Request {
  return new Request("https://preview.vapt.test/health", {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

test("missing or malformed bearer never invokes the API", async () => {
  let calls = 0;
  const delegate = async () => {
    calls += 1;
    return Response.json({ status: "ok" });
  };
  const duplicate = request(`Bearer ${secret}`);
  duplicate.headers.append("authorization", `Bearer ${secret}`);

  for (const input of [
    request(),
    request("Basic credentials"),
    request("Bearer wrong-token"),
    request(`bearer ${secret}`),
    request(`Bearer ${"x".repeat(300)}`),
    duplicate,
  ]) {
    const response = await handleParallelPreview(input, env, context, delegate);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
  }
  assert.equal(calls, 0);
});

test("missing secret or non-preview environment fails closed before API dispatch", async () => {
  let calls = 0;
  const delegate = async () => {
    calls += 1;
    return Response.json({ status: "ok" });
  };
  for (const bindings of [
    { ENVIRONMENT: "preview" } as WorkerBindings,
    { ...env, ENVIRONMENT: "production" as const },
  ]) {
    const response = await handleParallelPreview(request(`Bearer ${secret}`), bindings, context, delegate);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  }
  assert.equal(calls, 0);
});

test("valid bearer delegates once without forwarding its header", async () => {
  let calls = 0;
  const input = new Request("https://preview.vapt.test/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: "session=synthetic",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "delivered@resend.dev" }),
  });
  const response = await handleParallelPreview(input, env, context, async (forwarded) => {
    calls += 1;
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.url, input.url);
    assert.equal(forwarded.headers.get("authorization"), null);
    assert.equal(forwarded.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(await forwarded.json(), { email: "delivered@resend.dev" });
    return Response.json({ ok: true });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 1);
});

test("an API exception is sanitized without leaking the bearer", async () => {
  const response = await handleParallelPreview(request(`Bearer ${secret}`), env, context, async () => {
    throw new Error(`provider failure ${secret}`);
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.clone().text()).includes(secret), false);
  assert.deepEqual(await response.json(), {
    error: { code: "service_unavailable", message: "Service unavailable" },
  });
});
