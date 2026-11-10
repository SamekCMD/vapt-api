import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Pool } from "pg";
import type { ExecutionContext } from "hono";
import type { CreateEmailOptions } from "resend";

import type { ApiServices } from "../composition/api-services.js";
import { createResendAuthEmailService } from "../email/email.service.js";
import type { ResendEmailClient } from "../email/resend.client.js";
import { createBetterAuthOptions } from "../modules/auth/better-auth.js";
import { createWorkerApp } from "./app.js";
import { syntheticAuthConfig } from "./auth-context-test-support.js";
import type { WorkerBindings } from "./environment.js";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
const env: WorkerBindings = { ENVIRONMENT: "preview", CORS_ORIGINS: "https://app.vapt.test",
  AUTH_RATE_LIMIT: { async limit() { return { success: true }; } } };
const email = "unverified@example.invalid";

function fixture(t: TestContext, options: { exists?: boolean; verified?: boolean; accepted?: boolean } = {}) {
  const config = syntheticAuthConfig();
  config.email.verifyAccountTemplate = "account-confirmation";
  const sent: CreateEmailOptions[] = [];
  const tasks: Promise<unknown>[] = [];
  // Replace only external SQL, siteverify and email transport. The actual
  // production auth options, Hono, Better Auth and email service remain real.
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = { emails: { async send(payload: CreateEmailOptions) {
    sent.push(payload); return { data: { id: "synthetic-email-id" }, error: null };
  } } } as ResendEmailClient;
  const authOptions = createBetterAuthOptions(config, { pool,
    emailService: createResendAuthEmailService(client, config.email),
    runInBackground(task) { tasks.push(task); },
  });
  const now = new Date();
  const store = { user: options.exists === false ? [] : [{ id: "synthetic-owner", name: "Owner", email,
    emailVerified: options.verified ?? false, createdAt: now, updatedAt: now }],
    session: [], account: [], verification: [] };
  const auth = betterAuth({ ...authOptions, database: memoryAdapter(store),
    logger: { disabled: true }, rateLimit: { enabled: false } });
  let verifications = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.secret, "synthetic-turnstile");
    assert.equal(payload.response, "synthetic-challenge");
    verifications++;
    return Response.json({ success: options.accepted ?? true,
      "error-codes": options.accepted === false ? ["invalid-input-response"] : [],
      challenge_ts: now.toISOString(), hostname: "app.vapt.test" });
  });
  t.after(async () => { await Promise.all(tasks); await pool.end(); });
  const app = createWorkerApp(async () => ({ authRuntime: { handler: auth.handler } } as ApiServices));
  function request(path = "/send-verification-email", challenge?: string) {
    return new Request("https://api.vapt.test/api/auth" + path, { method: "POST",
      headers: { origin: "https://app.vapt.test", "cf-connecting-ip": "203.0.113.1",
        "content-type": "application/json", ...(challenge ? { "x-captcha-response": challenge } : {}) },
      body: JSON.stringify({ email, callbackURL: "https://app.vapt.test/" }),
    });
  }
  return { app, request, sent, tasks, verifications: () => verifications };
}

// Omitting this endpoint from production CAPTCHA options must turn these
// blocked requests into 200 plus an email, rather than pass unnoticed.
for (const environment of ["preview", "production"] as const) {
  test(`verification resend without CAPTCHA cannot send email in ${environment}`, async t => {
    const f = fixture(t);
    const response = await f.app.fetch(f.request(), { ...env, ENVIRONMENT: environment }, execution);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "MISSING_RESPONSE");
    await Promise.all(f.tasks);
    assert.equal(f.sent.length, 0);
    assert.equal(f.verifications(), 0);
  });
}

test("verification resend rejects a provider-rejected CAPTCHA without sending email", async t => {
  const f = fixture(t, { accepted: false });
  const response = await f.app.fetch(f.request(undefined, "synthetic-challenge"), env, execution);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "VERIFICATION_FAILED");
  await Promise.all(f.tasks);
  assert.equal(f.sent.length, 0);
  assert.equal(f.verifications(), 1);
});

test("verification resend with accepted CAPTCHA retains the published template and token link", async t => {
  const f = fixture(t);
  const response = await f.app.fetch(f.request(undefined, "synthetic-challenge"), env, execution);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: true });
  await Promise.all(f.tasks);
  assert.equal(f.verifications(), 1);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0];
  assert.equal(payload.from, "Vapt <test@vapt.test>");
  assert.equal(payload.to, email);
  assert.equal(payload.template?.id, "account-confirmation");
  const variables = payload.template?.variables;
  assert.ok(variables);
  assert.deepEqual(Object.keys(variables).sort(), ["CONFIRMATION_URL", "confirmation_code"]);
  const link = new URL(String(variables.CONFIRMATION_URL));
  assert.equal(link.origin, "https://api.vapt.test");
  assert.equal(link.pathname, "/api/auth/verify-email");
  assert.equal(link.searchParams.get("callbackURL"), "https://app.vapt.test/");
  assert.equal(link.searchParams.get("token"), variables.confirmation_code);
  assert.ok(String(variables.confirmation_code).length > 32);
  assert.equal("html" in payload || "text" in payload || "subject" in payload, false);
});

for (const [label, options] of [["unknown", { exists: false }], ["verified", { verified: true }]] as const) {
  test(`accepted resend does not reveal ${label} account or send email`, async t => {
    const f = fixture(t, options);
    const response = await f.app.fetch(f.request(undefined, "synthetic-challenge"), env, execution);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: true });
    await Promise.all(f.tasks);
    assert.equal(f.sent.length, 0);
    assert.equal(f.verifications(), 1);
  });
}

for (const path of ["/sign-up/email", "/sign-in/email", "/request-password-reset"]) {
  test(`${path} still requires CAPTCHA`, async t => {
    const f = fixture(t);
    const response = await f.app.fetch(f.request(path), env, execution);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "MISSING_RESPONSE");
    assert.equal(f.sent.length, 0);
  });
}

test("verification resend rate rejection precedes auth/provider work", async t => {
  const f = fixture(t);
  const response = await f.app.fetch(f.request(undefined, "synthetic-challenge"), {
    ...env, AUTH_RATE_LIMIT: { async limit() { return { success: false }; } },
  }, execution);
  assert.equal(response.status, 429);
  assert.equal(f.verifications(), 0);
  assert.equal(f.sent.length, 0);
});
