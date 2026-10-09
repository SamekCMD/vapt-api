import assert from "node:assert/strict";
import test from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import type { BetterAuthConfig } from "../lib/config.js";
import { createWorkerAuthRuntimeFactory, type WorkerAuthEngineBuilder } from "./auth-runtime.js";
import { deferred, syntheticAuthDependencies, syntheticAuthConfig, syntheticSchemaAuthDependencies } from "./auth-context-test-support.js";

test("cache initializes once, dispatches SQL/email on each invocation and close never ends pools", async () => {
  const events: string[] = [];
  let builds = 0;
  const gate = deferred<void>();
  const createEngine: WorkerAuthEngineBuilder = (_config, dep) => {
    builds++;
    return { ready: gate.promise, runtime: {
      async handler() {
        const client = await dep.pool.connect();
        try {
          const result = await client.query<{ owner: string }>("session", []);
          dep.runInBackground(dep.emailService.sendPasswordReset({ to: "synthetic@vapt.test", resetPasswordUrl: "https://vapt.test/reset" }));
          return Response.json(result.rows[0]);
        } finally { client.release(); }
      },
      async getSession() { return null; }, async close() {},
    } };
  };
  const factory = createWorkerAuthRuntimeFactory({ createEngine });
  const a = syntheticAuthDependencies("a", events);
  const b = syntheticAuthDependencies("b", events);
  const ra = factory(syntheticAuthConfig(), a, "preview");
  const rb = factory(syntheticAuthConfig(), b, "preview");
  const first = ra.handler(new Request("https://api.vapt.test/api/auth/get-session"));
  const second = rb.handler(new Request("https://api.vapt.test/api/auth/get-session"));
  gate.resolve();
  assert.deepEqual(await (await first).json(), { owner: "a" });
  assert.deepEqual(await (await second).json(), { owner: "b" });
  assert.equal(builds, 1);
  assert.deepEqual(events.filter(x => x.startsWith("a:")), ["a:connect", "a:session", "a:reset", "a:release"]);
  assert.deepEqual(events.filter(x => x.startsWith("b:")), ["b:connect", "b:session", "b:reset", "b:release"]);
  assert.equal(a.tasks.length, 1); assert.equal(b.tasks.length, 1);
  await Promise.all([...a.tasks, ...b.tasks]);
  await ra.close(); await rb.close();
  assert.ok(!events.some(x => x.endsWith(":end")));
});

test("every effective config field and environment replaces the sole cache entry", async () => {
  const edits: ((c: BetterAuthConfig) => void)[] = [
    c => { c.secret += "changed"; }, c => { c.url = new URL("http://api.other.test/path"); },
    c => { c.trustedOrigins.push("https://other.test"); }, c => { c.databaseUrl += "?changed"; },
    c => { c.turnstileSecretKey += "changed"; }, c => { c.email.resendApiKey += "changed"; },
    c => { c.email.from += "changed"; }, c => { c.email.verifyAccountTemplate += "changed"; },
    c => { c.email.resetPasswordTemplate += "changed"; },
  ];
  let builds = 0;
  const factory = createWorkerAuthRuntimeFactory({ createEngine: () => {
    builds++; return { ready: Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { return null; }, async close() {} } };
  } });
  const dep = syntheticAuthDependencies("test", []);
  await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
  await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
  assert.equal(builds, 1);
  for (const edit of edits) {
    const config = syntheticAuthConfig(); edit(config);
    await factory(config, dep, "preview").getSession(new Headers());
    await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
  }
  assert.equal(builds, 1 + edits.length * 2);
  await factory(syntheticAuthConfig(), dep, "production").getSession(new Headers());
  assert.equal(builds, 2 + edits.length * 2);
});

test("caller mutation cannot change an existing runtime config snapshot", async () => {
  const configs: BetterAuthConfig[] = [];
  const factory = createWorkerAuthRuntimeFactory({ createEngine: config => {
    configs.push(config);
    return { ready: Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { return null; }, async close() {} } };
  } });
  const config = syntheticAuthConfig();
  const original = factory(config, syntheticAuthDependencies("a", []), "preview");
  config.url.hostname = "mutated.test"; config.trustedOrigins.push("https://mutated.test"); config.email.from = "mutated";
  await original.getSession(new Headers());
  assert.equal(configs[0].url.hostname, "api.vapt.test");
  assert.deepEqual(configs[0].trustedOrigins, ["https://app.vapt.test"]);
  assert.equal(configs[0].email.from, "Vapt <test@vapt.test>");
});

test("failed initialization retries and an old rejected initialization cannot evict a newer entry", async () => {
  let builds = 0;
  const oldReady = deferred<void>();
  const factory = createWorkerAuthRuntimeFactory({ createEngine: config => {
    builds++;
    return { ready: config.secret.includes("old") ? oldReady.promise : Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { return null; }, async close() {} } };
  } });
  const old = syntheticAuthConfig(); old.secret += "old";
  const dep = syntheticAuthDependencies("test", []);
  const pending = factory(old, dep, "preview").getSession(new Headers());
  const rejection = assert.rejects(pending, /synthetic init failure/);
  await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
  oldReady.reject(new Error("synthetic init failure")); await rejection;
  await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
  assert.equal(builds, 2);
  let attempts = 0;
  const retry = createWorkerAuthRuntimeFactory({ createEngine: () => {
    attempts++; return { ready: attempts === 1 ? Promise.reject(new Error("retryable init")) : Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { return null; }, async close() {} } };
  } });
  const runtime = retry(syntheticAuthConfig(), dep, "preview");
  await assert.rejects(runtime.getSession(new Headers()), /retryable init/);
  assert.equal(await runtime.getSession(new Headers()), null);
  assert.equal(attempts, 2);
});

test("session failures do not evict a healthy initialized engine", async () => {
  let builds = 0; let calls = 0;
  const factory = createWorkerAuthRuntimeFactory({ createEngine: () => {
    builds++; return { ready: Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { if (++calls === 1) throw new Error("session unavailable"); return null; }, async close() {} } };
  } });
  const runtime = factory(syntheticAuthConfig(), syntheticAuthDependencies("test", []), "preview");
  await assert.rejects(runtime.getSession(new Headers()), /session unavailable/);
  assert.equal(await runtime.getSession(new Headers()), null);
  assert.equal(builds, 1);
});

test("cached real Better Auth still validates signed cookies and observes revocation on the next request", async () => {
  const now = new Date();
  const config = syntheticAuthConfig();
  const store = { user: [{ id: "user-1", name: "Synthetic", email: "test@vapt.test", emailVerified: true, createdAt: now, updatedAt: now }], session: [{ id: "session-1", token: "synthetic-token", userId: "user-1", expiresAt: new Date(Date.now() + 86400000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null }], account: [], verification: [] };
  let builds = 0;
  const factory = createWorkerAuthRuntimeFactory({ createEngine: () => {
    builds++;
    const auth = betterAuth({ baseURL: config.url.origin, secret: config.secret, database: memoryAdapter(store), advanced: { useSecureCookies: true } });
    return { ready: auth.$context.then(() => undefined), runtime: { handler: auth.handler, async getSession(headers) { return auth.api.getSession({ headers }); }, async close() {} } };
  } });
  const cookie = (await serializeSignedCookie("__Secure-better-auth.session_token", "synthetic-token", config.secret)).split(";")[0];
  const call = (value: string) => factory(config, syntheticAuthDependencies("test", []), "preview").getSession(new Headers({ cookie: value }));
  assert.equal((await call(cookie))?.user.id, "user-1");
  store.session.splice(0);
  assert.equal(await call(cookie), null);
  for (const invalid of ["", "analytics=synthetic", "__Secure-better-auth.session_token=invalid"]) assert.equal(await call(invalid), null);
  assert.equal(builds, 1);
});

test("default engine checks schema once and routes each signed-session lookup to its current pool", async () => {
  const events: string[] = [];
  const config = syntheticAuthConfig();
  const factory = createWorkerAuthRuntimeFactory();
  const unknownCookie = (await serializeSignedCookie("__Secure-better-auth.session_token", "unknown-synthetic-token", config.secret)).split(";")[0];
  for (const owner of ["a", "b"]) {
    const runtime = factory(config, syntheticSchemaAuthDependencies(owner, events), "preview");
    assert.equal(await runtime.getSession(new Headers({ cookie: unknownCookie })), null);
  }
  assert.equal(events.filter(x => x.endsWith(":schema")).length, 1);
  assert.ok(events.includes("a:session"));
  assert.ok(events.includes("b:session"));
  assert.ok(!events.includes("b:schema"));
});

test("default engine fails closed on missing schema and retries with a healthy invocation", async () => {
  const events: string[] = [];
  const factory = createWorkerAuthRuntimeFactory();
  await assert.rejects(factory(syntheticAuthConfig(), syntheticSchemaAuthDependencies("bad", events, true), "preview").getSession(new Headers()), { code: "SCHEMA_MISMATCH" });
  assert.equal(await factory(syntheticAuthConfig(), syntheticSchemaAuthDependencies("good", events), "preview").getSession(new Headers()), null);
  assert.ok(events.includes("bad:schema")); assert.ok(events.includes("good:schema"));
});
