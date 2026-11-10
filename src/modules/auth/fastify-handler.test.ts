import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerErrorHandler } from "../../plugins/error-handler.js";
import { registerBetterAuthHandler } from "./fastify-handler.js";

test("Better Auth bridge forwards GET and POST using the configured API origin", async () => {
  const requests: Request[] = [];
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerBetterAuthHandler(
    app,
    new URL("https://api.preview.vapt.test"),
    async (request) => {
      requests.push(request);
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.append("set-cookie", "session=one; Path=/; HttpOnly");
      headers.append("set-cookie", "csrf=two; Path=/; Secure");
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers,
      });
    },
  );

  const getResponse = await app.inject({
    method: "GET",
    url: "/api/auth/get-session?fresh=true",
    headers: { host: "attacker.example", "x-captcha-response": "captcha-get" },
  });
  const postResponse = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: {
      host: "attacker.example",
      "content-type": "application/json",
      "x-captcha-response": "captcha-post",
    },
    payload: { email: "owner@example.com", password: "secret-password" },
  });

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.url,
    "https://api.preview.vapt.test/api/auth/get-session?fresh=true",
  );
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.get("host"), "api.preview.vapt.test");
  assert.equal(requests[0]?.headers.get("x-captcha-response"), "captcha-get");
  assert.equal(
    requests[1]?.url,
    "https://api.preview.vapt.test/api/auth/sign-up/email",
  );
  assert.equal(requests[1]?.method, "POST");
  assert.equal(requests[1]?.headers.get("x-captcha-response"), "captcha-post");
  assert.deepEqual(await requests[1]?.json(), {
    email: "owner@example.com",
    password: "secret-password",
  });
  assert.equal(getResponse.statusCode, 201);
  assert.deepEqual(getResponse.json(), { ok: true });
  assert.match(String(getResponse.headers["content-type"]), /^application\/json/);
  assert.deepEqual(getResponse.cookies.map((cookie) => cookie.name), ["session", "csrf"]);
  assert.equal(postResponse.statusCode, 201);

  await app.close();
});

test("Better Auth bridge converts thrown handler errors to the generic API contract", async () => {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerBetterAuthHandler(
    app,
    new URL("https://api.preview.vapt.test"),
    async () => {
      throw new Error("secret-cookie=do-not-leak token=do-not-leak");
    },
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { cookie: "secret-cookie=do-not-leak" },
    payload: { token: "do-not-leak" },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: { code: "internal_error", message: "Internal server error" },
  });
  assert.doesNotMatch(response.body, /secret-cookie|do-not-leak|token/);
  await app.close();
});
