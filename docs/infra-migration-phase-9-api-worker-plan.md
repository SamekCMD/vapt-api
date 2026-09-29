# Vapt API Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a Cloudflare Workers-compatible build of the existing Fastify API and prove critical HTTP behavior in `workerd`, without public deployment or changing the Coolify API.

**Architecture:** Keep `buildApp()` and the Node `src/server.ts` entrypoint. Add a typed Worker binding/configuration adapter, explicit runtime dependencies, and a lazy Worker HTTP bridge around Fastify. Replace process-local Worker assumptions (rate-limit map, payment-effect interval, detached auth-email promise) with Worker-safe adapters, then exercise the bundle through Wrangler's `createTestHarness()`.

**Tech Stack:** Node 24, TypeScript/NodeNext, Fastify 5, `pg` 8.23, Better Auth 1.7.6, Stripe 22.6.2, Wrangler 4.138.0, `tsx --test`, Cloudflare `workerd` test harness.

**Spec:** `docs/infra-migration-phase-9-api-worker-design.md`

**Execution status (2026-09-29):** Tasks 1–3 completed. Task 4 hit a `workerd` runtime compatibility gate; Tasks 4–6 are paused. See `docs/infra-migration-phase-9-runtime-blocker.md`. The Worker is not deployed or ready to merge.

## Global Constraints

- Stage 9 is code and local-runtime verification only. Do not deploy a Worker, create Hyperdrive or secrets, change DNS, modify Coolify, or send real provider requests.
- Preserve the Node/Docker entrypoint and existing public routes, authorization, webhook signatures, response error shapes and business services.
- Keep preview and production separate. A missing `HYPERDRIVE` or rate-limit binding fails closed; never fall back to a production `DATABASE_URL` or an isolate-local security limit.
- Use an explicit binding-to-config conversion; `process.env.NODE_ENV` may be replaced at build time by Wrangler, so the Worker must not derive its environment from it.
- Retain the existing Node test runner and 397-test baseline. Add a separate `test:worker` command for runtime integration. Use Wrangler `4.138.0` to match the already deployed billing Worker.
- A Wrangler dry-run is a packaging check, not runtime proof. If the Fastify HTTP bridge or a dependency fails in `workerd`, stop at that gate and revise the design; do not silently rewrite the route framework.
- No secret values, connection strings or synthetic recipient addresses in logs or committed fixtures. Preserve Stripe Test Mode for synthetic checks.

## Review Focus

1. Whitespace-sensitive signed webhook bytes must reach Stripe/Mercado Pago validation unchanged: Task 5 tests a formatted body and invalid signature through `workerd`.
2. Multiple Better Auth `Set-Cookie` headers and credentialed CORS must survive the bridge: Task 5 tests both via the Worker endpoint.
3. Missing/invalid bindings must not fall back to Coolify or production Neon: Task 1 tests configuration rejection and Task 4 tests a sanitized unavailable response.
4. Concurrent first requests and an expired payment-effect lease must not start duplicate app instances or timers: Tasks 3, 4 and 6 test no timer, initialization coalescing and one bounded scheduled run.
5. Rate limiting must not become per-isolate memory in Workers: Task 2 tests binding selection, fail-closed behavior and Node parity.

---

### Task 1: Worker configuration contract and isolated test harness

**Files:**
- Create: `src/worker/environment.ts`, `src/worker/environment.test.ts`
- Create: `wrangler.worker.jsonc`, `wrangler.worker-test.jsonc`, `tsconfig.worker.json`
- Modify: `package.json`, `package-lock.json`, `.gitignore`

**Interfaces:**
- Produces `WorkerBindings`: typed string configuration plus optional `HYPERDRIVE: { connectionString: string }` and later rate-limit bindings.
- Produces `configFromWorkerBindings(env: WorkerBindings): AppConfig`; it copies the required `CORS_ORIGINS`, `STRIPE_*`, `FRONTEND_URL`, `PUBLIC_ORDER_TOKEN_SECRET`, `BETTER_AUTH_*`, `TURNSTILE_SECRET_KEY`, `RESEND_*`, and `EMAIL_FROM` keys, plus the optional `R2_*`, `MERCADO_PAGO_*`, `API_PUBLIC_URL`, `PAYMENT_EFFECTS_*` and `LOG_LEVEL` groups from `createConfig()`. It sets `NODE_ENV=production` for both Worker environments, replaces `DATABASE_URL` only with `HYPERDRIVE.connectionString`, and rejects a missing binding before returning.
- Produces `npm run test:worker` (`tsx --test src/worker/*.workerd.ts`) for Node-runner integration tests through `createTestHarness()` and `npm run build:worker` (`wrangler deploy --dry-run --config wrangler.worker.jsonc`) for a Wrangler dry-run. The `.workerd.ts` suffix keeps these tests out of the existing `src/**/*.test.ts` Node suite.

- [ ] **Step 1: Write failing config tests** in `environment.test.ts`: missing `HYPERDRIVE` rejects without printing another binding's value; `ENVIRONMENT=preview` with synthetic `STRIPE_ENVIRONMENT=test` maps to `AppConfig`, while preview with live mode rejects; production with test mode remains valid until the separate Stripe Live activation gate; optional Mercado Pago and R2 settings are forwarded only as complete groups.

  ```ts
  assert.throws(() => configFromWorkerBindings({ ...validPreview, HYPERDRIVE: undefined }), /HYPERDRIVE/);
  assert.equal(configFromWorkerBindings(validPreview).stripe.environment, "test");
  assert.throws(() => configFromWorkerBindings({ ...validPreview, STRIPE_ENVIRONMENT: "live" }), /preview/);
  ```
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/environment.test.ts`; expect missing module/function assertions, not a network error.
- [ ] **Step 3: Implement `WorkerBindings` and `configFromWorkerBindings`**. Reuse `createConfig()` for all existing validation; add only Worker-specific environment/binding checks. Do not import `cloudflare:workers` in this pure function.
- [ ] **Step 4: Add package/config support**: pin Wrangler `4.138.0`; add `test:worker` and `build:worker`; name the non-deployed config `vapt-api-preview` and the fixture config `vapt-api-worker-test`; set a Worker compatibility date on or after `2026-08-04`, `workers_dev:false`, `preview_urls:false`, no routes or triggers, and no secret values. Keep Node `npm test` and `npm run build` unchanged. Set up Worker-only TypeScript types without changing Node's `tsconfig.json` coverage of `src/server.ts`.
- [ ] **Step 5: Run GREEN:** focused test, `npm run build`, `npm test`; expect all existing tests to remain green. `build:worker` is deferred until Task 4 supplies its entrypoint.
- [ ] **Step 6: Commit** the configuration contract and its tests.

### Task 2: Rate-limit backend for Workers

**Files:**
- Modify: `src/plugins/rate-limit.ts`, `src/plugins/rate-limit.test.ts`, `src/app.ts`
- Create: `src/worker/rate-limit.ts`, `src/worker/rate-limit.test.ts`

**Interfaces:**
- Produces `RateLimitBackend.limit(group: RateLimitGroup, actorKey: string): Promise<{ allowed: boolean; remaining?: number; resetAt?: number }>`; `registerRateLimit()` retains the current in-memory backend only as the Node default.
- Produces `createWorkerRateLimitBackend(env: WorkerBindings): RateLimitBackend`; `auth`, `billing`, `orders`, `storage`, `webhooks` and `public` map respectively to `AUTH_RATE_LIMIT`, `BILLING_RATE_LIMIT`, `ORDERS_RATE_LIMIT`, `STORAGE_RATE_LIMIT`, `WEBHOOKS_RATE_LIMIT` and `PUBLIC_RATE_LIMIT`. Health bypasses them, and absent bindings reject rather than using a map.
- `buildApp()` accepts an optional injected `rateLimitBackend`; Node callers keep the existing behavior.

- [ ] **Step 1: Write failing tests**: Node's current grouped 20/60/30/300 limits and forwarded-IP behavior stay intact; a fake Worker binding is called with the intended group/actor key; deny returns the existing 429 error shape; a missing binding rejects; `health` does not consume a binding. The Worker emits a limit header but omits `remaining`/`reset` when the platform binding cannot report them, rather than fabricating counters.

  ```ts
  assert.equal((await secondAuthRequest()).statusCode, 429);
  assert.deepEqual(fakeAuthBinding.keys, ["auth:203.0.113.10"]);
  assert.equal((await deniedWorkerRequest()).json().error.code, "rate_limit_exceeded");
  assert.equal(fakeHealthBinding.calls, 0);
  ```
- [ ] **Step 2: Run RED:** `npx tsx --test src/plugins/rate-limit.test.ts src/worker/rate-limit.test.ts`; expect the new injection/binding tests to fail.
- [ ] **Step 3: Implement the injectable backend** and Worker binding adapter; keep current Node behavior as default. Use a separate binding per protected policy group and leave namespace IDs as later deployment configuration, not secrets in source.
- [ ] **Step 4: Run GREEN:** focused tests and full `npm test`; expect Node behavior unchanged and Worker binding failures to be explicit.
- [ ] **Step 5: Commit** the rate-limit boundary and tests.

### Task 3: App lifecycle suitable for request-driven Workers

**Files:**
- Modify: `src/app.ts`, `src/app.test.ts`, `src/modules/payments/service.ts`, `src/modules/payments/reconciliation.test.ts`, `src/modules/auth/better-auth.test.ts`
- Create: `src/worker/lifecycle.ts`, `src/worker/lifecycle.test.ts`

**Interfaces:**
- Extend `BuildAppDependencies` with `runInBackground?: BackgroundTaskRunner`, `startPaymentReconciliation?: boolean`, `rateLimitBackend?: RateLimitBackend`, and `workerId?: string`.
- Produce `createWorkerLifecycle(waitUntil: (task: Promise<unknown>) => void, onError: (code: 'auth_email_failed') => void): { runInBackground: BackgroundTaskRunner; workerId: string }`; the runner logs only that safe code on failure and passes the caught promise to `waitUntil`.
- `app.payments.reconciliation.runOnce(limit?)` remains the Scheduled handler's single-pass interface; Node's interval remains the default outside tests.

- [ ] **Step 1: Write failing tests**: Worker composition does not call `reconciliation.start()` during `app.ready()`; Node composition still does in non-test mode; the Worker-generated ID is UUID-based and never reads `process.pid`; a rejected auth email promise is passed to `waitUntil` with sanitized logging; two simultaneous `runOnce()` calls still coalesce.

  ```ts
  assert.equal(workerTimerStarts, 0);
  assert.equal(nodeTimerStarts, 1);
  assert.match(createWorkerLifecycle(waitUntil, onError).workerId, /^payment-effects-[0-9a-f-]{36}$/);
  assert.deepEqual(safeErrorCodes, ["auth_email_failed"]);
  assert.equal(processCallsAfterConcurrentRuns, 1);
  ```
- [ ] **Step 2: Run RED:** `npx tsx --test src/app.test.ts src/worker/lifecycle.test.ts src/modules/payments/reconciliation.test.ts`; expect only new assertions to fail.
- [ ] **Step 3: Implement lifecycle injection** with Node defaults in `buildApp` and `registerPaymentModule`. The Worker does not create an interval; the existing leased effect processor remains authoritative. Avoid changing the service/repository transaction semantics.
- [ ] **Step 4: Run GREEN:** focused tests and full `npm test`; expect no detached Worker email work or process-local timer.
- [ ] **Step 5: Commit** the lifecycle boundary and tests.

### Task 4: Fastify HTTP bridge and Worker entrypoint

**Files:**
- Create: `src/worker/http.ts`, `src/worker/index.ts`, `src/worker/test-fixture.ts`, `src/worker/http.workerd.ts`
- Modify: `wrangler.worker.jsonc`, `wrangler.worker-test.jsonc`, `tsconfig.worker.json`, `package.json`
- Modify only if the runtime test proves necessary: `src/plugins/raw-body.ts`, `src/modules/auth/fastify-handler.ts`

**Interfaces:**
- Produce `createWorkerHttpHandler(createApp: (env: WorkerBindings) => Promise<FastifyInstance>): (request: Request, env: WorkerBindings, ctx: ExecutionContext) => Promise<Response>`; it promise-caches `app.ready()`, uses Cloudflare `httpServerHandler(app.server)`, and resets a failed initialization for retry.
- `src/worker/index.ts` exports `fetch`; it builds `AppConfig` from bindings, uses injected Worker lifecycle/rate limiting, and returns a sanitized 503 for initialization/binding failure. Task 6 adds `scheduled`. The production entrypoint never imports the test fixture.
- `src/worker/test-fixture.ts` composes the real Fastify routes with fake database/auth/provider dependencies for local `workerd` tests only.

- [ ] **Step 1: Write failing `workerd` smoke tests** with Wrangler `createTestHarness({ workers: [{ configPath: './wrangler.worker-test.jsonc' }, { configPath: './wrangler.worker.jsonc' }] })`: the test fixture's `GET /health` returns Fastify JSON, `/missing` returns the established 404 shape, and a fixture-only initialization counter shows two concurrent first requests create one app; `server.getWorker('vapt-api-preview')` with no `HYPERDRIVE` returns sanitized 503 without opening a database.

  ```ts
  assert.deepEqual(await (await fixture.fetch("/health")).json(), { status: "ok" });
  assert.equal((await fixture.fetch("/missing")).status, 404);
  assert.equal(await fixtureInitCountAfterTwoConcurrentRequests(), 1);
  assert.equal((await realWorker.fetch("/health")).status, 503);
  ```
- [ ] **Step 2: Run RED:** `npm run test:worker`; expect the absent entrypoint/adapter failure, not an inability to spawn `workerd`. On Windows, an `EPERM` process-spawn denial requires an approved execution retry, not a source change.
- [ ] **Step 3: Implement the bridge and entrypoints**. Use the official Node HTTP server bridge, preserving URL, method, headers and body. Keep the fixture separate from the production bundle; no route/custom domain/worker.dev URL and no Cron in configuration.
- [ ] **Step 4: Run GREEN:** `npm run test:worker`, `npm run build:worker`, `npm run build`; expect a real `workerd` response, clean Wrangler dry-run and strict typecheck. If a package fails at runtime, add only a targeted compatibility fix with a failing test or stop and revise the spec.
- [ ] **Step 5: Commit** the HTTP bridge and first runtime smoke.

### Task 5: Security-sensitive HTTP parity in `workerd`

**Files:**
- Create: `src/worker/http-parity.workerd.ts`
- Modify as regression evidence requires: `src/worker/test-fixture.ts`, `src/worker/http.ts`, `src/plugins/raw-body.ts`, `src/modules/auth/fastify-handler.ts`

**Interfaces:**
- Uses the Task 4 fixture and `createTestHarness` to exercise the actual Worker HTTP boundary; no real provider or database calls.

- [ ] **Step 1: Write failing tests** for formatted Stripe raw body and valid/invalid signatures; Mercado Pago raw body and missing/invalid signature through its real verifier with fake persistence/provider; duplicate webhook response shape; two `Set-Cookie` headers and secure flags; credentialed CORS preflight with `X-Captcha-Response`; idempotency and public-order-token request headers; malformed JSON with no signature/secret leakage.

  ```ts
  assert.equal(stripeVerifiedRaw, formattedStripePayload);
  assert.equal(invalidSignatureResponse.status, 401);
  assert.equal(authResponse.headers.getSetCookie().length, 2);
  assert.equal(corsResponse.headers.get("access-control-allow-credentials"), "true");
  assert.doesNotMatch(await malformedResponse.text(), /whsec_|sk_test_|re_test_/);
  ```
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/http-parity.workerd.ts`; require a behavior assertion to fail before altering the affected bridge/plugin path. A test that already passes needs no code change.
- [ ] **Step 3: Apply only the compatibility fixes proved necessary**, preserving the existing Node API route behavior and exact bytes/headers. Do not mock away Fastify in this parity suite.
- [ ] **Step 4: Run GREEN:** parity tests, `npm test`, `npm run test:worker`, `npm run build`; expect all to pass without contacting Stripe, Resend, Mercado Pago or Neon.
- [ ] **Step 5: Commit** parity tests and any targeted fix.

### Task 6: Scheduled reconciliation, CI and handoff

**Files:**
- Create: `src/worker/scheduled.workerd.ts`, `docs/infra-migration-phase-9-api-worker.md`
- Modify: `src/worker/index.ts`, `.github/workflows/ci.yml`, `package.json`, `wrangler.worker-test.jsonc`

**Interfaces:**
- The exported Worker `scheduled` handler invokes exactly one bounded `app.payments.reconciliation.runOnce()`; it does not require a live Cron in Stage 9.
- CI runs the existing Node suite/build, `test:worker`, and `build:worker` without live secrets.

- [ ] **Step 1: Write failing scheduled tests** using `server.getWorker('vapt-api-worker-test').scheduled({ cron: '* * * * *', scheduledTime: new Date() })`, with the fixture delegating to the real scheduled helper: one invocation processes at most configured batch size, overlapping invocations share the in-instance run, a processor failure rejects/logs safely for retry visibility, and no interval is installed. Supply a fake processor/database; no real email or payment is emitted.

  ```ts
  await fixture.scheduled({ cron: "* * * * *", scheduledTime: new Date() });
  assert.equal(processBatchCalls, 1);
  assert.ok(lastRequestedLimit <= configuredBatchSize);
  assert.equal(intervalStarts, 0);
  ```
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/scheduled.workerd.ts`; expect the missing scheduled behavior to fail.
- [ ] **Step 3: Complete scheduled handling and CI**. Keep `wrangler.worker.jsonc` triggerless and unrouted. CI must not use `.dev.vars` or production bindings. Document remaining Stage 10 work: dedicated Neon role, separate Hyperdrive bindings, database connection lifetime, remote preview smoke, rate-limit namespace IDs and Worker secret installation.
- [ ] **Step 4: Run GREEN and final verification:** `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, `git diff --check`, `git status --short`. Confirm `src/server.ts`/Docker still start under their existing tests and no Worker deployment was made.
- [ ] **Step 5: Commit** the scheduled/CI/runbook changes and hand off exact test totals and any runtime limitations.
