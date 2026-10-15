# Vapt API Worker-Native Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the complete Vapt API HTTP surface to a Hono-based Cloudflare Worker and prove local `workerd` parity, without deploying or changing the Coolify API.

**Architecture:** Keep the Node/Fastify entrypoint while extracting reusable service composition and non-HTTP decisions. A static Hono router consumes per-invocation Worker bindings/context and the same services/schemas; `fetch` and `scheduled` are separate entrypoints over that composition. Contract tests compare the two HTTP adapters, and a Wrangler harness executes the actual Worker bundle.

**Tech Stack:** TypeScript/Node 24, Fastify 5, Hono, Better Auth 1.7.6, Stripe 22.6.2, `pg` 8.23.0/Kysely, Wrangler 4.138.0, `tsx --test`, Cloudflare `workerd` test harness.

**Spec:** `docs/superpowers/specs/2026-09-29-vapt-api-worker-native-routing-design.md`

## Global Constraints

- Stage 9 is code and local-runtime verification only: no Worker deploy, public route, Cron trigger, DNS/Coolify change, real Neon/Hyperdrive/R2 resource, provider request, or secret installation.
- Do not proxy any Worker route to Coolify. Keep `src/server.ts`, `src/app.ts`, Docker, and the Node test suite usable throughout.
- Preserve every current method/path/alias, status, error code, validation rule, session/authorization decision, redirect, cookie, CORS behavior, signed webhook byte sequence, and idempotency rule.
- Reuse existing services/repositories/schemas; extract transport-independent logic only when needed to prevent divergent Fastify/Hono implementations. No unrelated refactor.
- Worker binding/configuration, rate-limit backend, and background lifecycle from completed old-plan Tasks 1–3 remain the starting point. Missing required bindings fail closed; no production `DATABASE_URL` fallback or isolate-memory rate limit.
- Worker route registration is static at module startup; bindings are read from the current invocation. Optional endpoints register statically but respond with the same 404 as Fastify when their configuration is absent. Preview can never use Stripe Live. No real secret value or recipient address appears in tests, logs, or committed configuration; unmistakably synthetic signature keys may be used in tests.
- Stage 9 uses synthetic dependencies. Real Hyperdrive/Neon/pool lifecycle is Stage 10; real preview upload/delete and parallel operation are Stage 11; public cutover is Stage 13.
- Use TDD for every behavioral task: record a failing assertion, implement the minimal change, run focused and cumulative checks, then commit. A Wrangler dry-run alone is not runtime proof.

## File structure and interfaces

| Unit | Responsibility |
| --- | --- |
| `src/worker/index.ts`, `src/worker/app.ts`, `src/worker/test-fixture.ts` | Production `fetch`/`scheduled` export, static Hono registration, synthetic harness composition. |
| `src/worker/http.ts`, `src/worker/route-contract.ts` | Worker context, CORS/auth/rate-limit/error/body helpers and exact route inventory. |
| `src/worker/routes/*.ts` | Thin domain HTTP adapters; each imports its existing service/schema, never a Fastify runtime module. |
| `src/composition/api-services.ts`, `src/modules/payments/composition.ts` | Transport-independent service wiring and payment reconciliation without a process timer. |
| `src/worker/services.ts`, `src/worker/scheduled.ts` | Binding-to-services adapter and one bounded scheduled run; real connection lifetime remains a Stage 10 gate. |
| `src/worker/*.workerd.ts`, existing `src/**/*.test.ts` | Bundled Worker HTTP/cron tests and Node parity tests. |

`ApiServices` is the inferred return type of `createApiServices(config: AppConfig, dependencies: ApiServiceDependencies)`. `ApiServiceDependencies` requires a `Database` and allows the existing `BuildAppDependencies` overrides (auth runtime, Stripe gateway, rate-limit backend, background runner, worker ID, timer switch) plus explicit provider/storage fakes. Domain service fields initialize lazily so a health request cannot construct Stripe, Better Auth, or payment clients. `WorkerHonoEnv` has `Bindings: WorkerBindings` and request variables `config: AppConfig`, `services: ApiServices`, and `auth: AuthContext | null`. `createWorkerApp(createServices: WorkerServicesFactory)` accepts `(env: WorkerBindings, ctx: ExecutionContext) => Promise<ApiServices>`; the production factory uses `configFromWorkerBindings`, and the fixture factory injects synthetic dependencies. The implementer may split domain fields of `ApiServices` into focused sub-objects, but must keep these public names/signatures stable across tasks.

## Review Focus

1. Percent-encoded path/query and `HEAD`/`OPTIONS` input must not accidentally match a different route or leak a body; Task 1/3 tests the Fastify-equivalent status/headers.
2. A missing or malformed Cloudflare client-IP signal must not bypass a protected Worker rate limit by trusting arbitrary `X-Forwarded-For`; Task 3 tests the explicit denial path.
3. Multiple Better Auth `Set-Cookie` values must not collapse into one comma-joined header; Task 4 tests two distinct cookies and secure flags.
4. Whitespace-bearing JSON and wrong content type on Stripe/Mercado Pago webhooks must preserve byte-exact verification and the expected retry/error response; Tasks 7–8 test both.
5. Optional Mercado Pago sandbox diagnostics and R2 routes must be absent when configuration is absent, while their normal configurations are complete; Tasks 8–9 test both configurations and Task 10 checks the inventory.

---

### Task 1: Native Worker bootstrap and route inventory

**Files:** Create `src/worker/app.ts`, `src/worker/index.ts`, `src/worker/test-fixture.ts`, `src/worker/route-contract.ts`, `src/worker/smoke.workerd.ts`, `src/worker/route-contract.test.ts`; modify `package.json`, `package-lock.json`, `wrangler.worker.jsonc`, `wrangler.worker-test.jsonc`.

**Interfaces:** Produce `createWorkerApp(): Hono<WorkerHonoEnv>` initially with `/health`; Task 2 adds `/health/ready` using the real payment-reconciliation snapshot and introduces the `WorkerServicesFactory` parameter. Produce `ROUTE_CONTRACTS: readonly { method: string; path: string; group: RateLimitGroup | null; auth: boolean; condition?: "mercado-pago" | "mercado-pago-sandbox" | "r2" }[]`, inventoried from all current `src/modules/**/routes.ts`, including `GET|POST /api/auth/*` and the Mercado Pago webhook alias.

- [ ] **Step 1: Write RED tests.** `route-contract.test.ts` loops over `ROUTE_CONTRACTS` with `assert.equal(app.hasRoute({ method, url: path }), true)` under enabled options and checks Fastify's conditional-route absence under disabled options. `smoke.workerd.ts` uses `createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }, { configPath: "./wrangler.worker.jsonc" }] })`; assert `deepEqual(await health.json(), {status:"ok"})`, encoded param/query round-trip, and `equal(missingBinding.status, 503)` with no secret in the body.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/route-contract.test.ts src/worker/smoke.workerd.ts`; expect absent exports/entrypoints, not a `workerd` spawn failure.
- [ ] **Step 3: Implement.** Add Hono to the lockfile, static route registration and both entrypoints. Keep `workers_dev:false`, `preview_urls:false`, and no routes/triggers. The fixture has only synthetic values; the production entrypoint validates bindings before serving. Do not import `src/app.ts` into the Worker.
- [ ] **Step 4: Run GREEN.** Focused tests, `npm run build`, `npm run build:worker`, `npm test`; require actual `workerd` responses and zero failures.
- [ ] **Step 5: Commit** bootstrap, inventory, and tests.

### Task 2: Shared service composition without Fastify lifecycle

**Files:** Create `src/composition/api-services.ts`, `src/composition/api-services.test.ts`, `src/modules/payments/composition.ts`; modify `src/app.ts`, `src/modules/payments/service.ts`, `src/worker/app.ts`, `src/worker/test-fixture.ts`, `src/worker/services.ts` (create), `src/worker/composition.workerd.ts` (create).

**Interfaces:** Produce `createApiServices(config: AppConfig, dependencies: ApiServiceDependencies): ApiServices`; `createPaymentModule(config: AppConfig, database: Database, providers: readonly PaymentProvider[], options: { workerId: string; onError(error: unknown): void }): PaymentModule`; `createWorkerServices(env: WorkerBindings, ctx: ExecutionContext, overrides?: ApiServiceOverrides): Promise<ApiServices>`; and `createWorkerApp(createServices: WorkerServicesFactory): Hono<WorkerHonoEnv>`. `buildApp()` retains its owned-Pool close hook, decorator, and Node timer behavior; Worker composition never calls `reconciliation.start()`.

- [ ] **Step 1: Write RED tests.** In `api-services.test.ts`, assert `strictEqual(services.authRuntime, injectedAuth)`, `deepEqual(services.payments.registry.codes(), ["manual"])`, and `equal(constructorCallsAfterHealth, 0)` for auth/Stripe/payment clients; assert Node's timer starts only under its existing rule and Worker `startCalls === 0`. `composition.workerd.ts` imports real shared composition with fake database/providers and asserts `equal((await fixture.fetch("/health")).status, 200)` plus `deepEqual((await ready.json()).paymentEffects, fakeReconciliation.snapshot())` in `workerd`.
- [ ] **Step 2: Run RED.** `npx tsx --test src/composition/api-services.test.ts src/worker/composition.workerd.ts`; expect missing factory/failed assertion.
- [ ] **Step 3: Implement.** Move only reusable wiring out of `src/app.ts` and split `registerPaymentModule` into a pure creator plus Fastify decorator/lifecycle wrapper. Construct the production adapter from current `env` and the Hyperdrive connection string, but make no real query in Stage 9 tests; Stage 10 owns connection-lifetime proof. Inject fixture dependencies without importing Fastify into the bundle.
- [ ] **Step 4: Run GREEN.** Focused tests, `npm test`, `npm run build`, `npm run build:worker`. Any actual `workerd` import/runtime incompatibility is a stop-and-diagnose gate; do not mock away the failing import.
- [ ] **Step 5: Commit** the shared composition boundary.

### Task 3: Worker HTTP policy and error parity

**Files:** Create `src/worker/http.ts`, `src/worker/http.workerd.ts`; modify `src/worker/app.ts`, `src/worker/route-contract.ts`, `src/worker/test-fixture.ts`, `src/worker/rate-limit.ts` only if the tested Worker adapter needs it.

**Interfaces:** Produce `requireWorkerAuth(c: Context<WorkerHonoEnv>): Promise<AuthContext>`, `workerRateLimit(group: RateLimitGroup): MiddlewareHandler<WorkerHonoEnv>`, and `parseWorkerJson(request: Request): Promise<unknown>`; `createWorkerApp` supplies JSON `AppError`/404 mapping and credentialed allowlist CORS. Protected rate limits take a trusted direct-ingress `cf-connecting-ip` value or reject; they never use caller-supplied `x-forwarded-for` as a fallback.

- [ ] **Step 1: Write RED HTTP tests.** Add fixture-only `/_test/protected` to exercise policy without exposing a production route. Assert `equal(preflight.headers.get("access-control-allow-credentials"), "true")`, `equal(missingIp.status, 429)`, `equal(missingLimiter.status, 503)`, `deepEqual(await unknown.json(), {error:{code:"not_found",message:"Route not found"}})`, and `equal(malformed.status, 400)` without a secret in its body. Compare allowed/disallowed origins, spoofed `X-Forwarded-For`, encoded path, and `HEAD`/`OPTIONS` status/headers with the same Fastify requests.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/http.workerd.ts`; expect behavior failures.
- [ ] **Step 3: Implement.** Apply CORS/error mapping globally and auth/rate-limit per route contract. Preserve `Headers` multiplicity and avoid parsing bodies in generic middleware. Keep the committed Worker binding backend; health bypasses it.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** the HTTP policy adapter.

### Task 4: Better Auth and protected sessions

**Files:** Create `src/worker/routes/auth.ts`, `src/worker/auth.workerd.ts`; modify `src/modules/auth/session-resolver.ts`, `src/modules/auth/session-resolver.test.ts` (create if absent), `src/worker/app.ts`, `src/worker/test-fixture.ts`.

**Interfaces:** Produce `registerWorkerAuthRoutes(app: Hono<WorkerHonoEnv>): void`. `AuthRuntime.handler(Request)` receives the original `/api/auth/*` request directly; `AuthRuntime.getSession(Headers)` resolves `/auth/me` and `/auth/restaurants/:restaurantId/access` through the existing ownership checker. Node's existing `SessionResolver` signature remains callable.

- [ ] **Step 1: Write RED tests.** Assert `equal(authResponse.headers.getSetCookie().length, 2)` with `Secure`, `HttpOnly`, and same-site attributes, `equal(noSession.status, 401)`, and `equal(bearerOnly.status, 401)`. A fake `AuthRuntime` records GET/POST method, query and body unchanged; compare owner/non-owner access and credentialed CORS with Node. Assert one `waitUntil` registration for email and no recipient/secret in failure logs.
- [ ] **Step 2: Run RED.** `npx tsx --test src/modules/auth/session-resolver.test.ts src/worker/auth.workerd.ts`; expect missing Worker routes/failed assertions.
- [ ] **Step 3: Implement.** Mount the Fetch handler without the Fastify `fromNodeHeaders` bridge. Give `createSessionResolver` a `Headers`-accepting path while preserving existing Node calls. Keep the Worker lifecycle from old-plan Task 3.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** auth/session parity.

### Task 5: Public catalog, orders, table sessions and feedback

**Files:** Create `src/worker/routes/public.ts`, `src/worker/public.workerd.ts`; modify `src/worker/app.ts` and only the corresponding Fastify route modules when extracting a non-HTTP decision (`catalog`, `orders`, `table-sessions`, `feedback`).

**Interfaces:** Produce `registerWorkerPublicRoutes(app: Hono<WorkerHonoEnv>): void`, covering catalog, public-order create/read, feedback, and public table-session check request. Use the existing `CatalogService`, `OrderService`, `FeedbackService`, and schemas from their modules; preserve `Idempotency-Key` and `X-Vapt-Order-Token`.

- [ ] **Step 1: Write RED tests.** Assert `equal(created.status, 201)`, `equal(replayed.status, 200)`, `equal(idempotencyConflict.status, nodeConflict.status)`, and `equal(missingToken.status, nodeMissingToken.status)`. Compare malformed UUID/body, catalog, feedback, and public check-request responses with Node, and assert every public manifest method/path resolves in the fixture.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/public.workerd.ts`; expect unregistered route/behavior failures.
- [ ] **Step 3: Implement.** Add thin Hono routes using shared service factories and Zod schemas. Extract only handler decisions that would otherwise be duplicated.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** public route parity.

### Task 6: Restaurant, menu, kitchen, overview and private table sessions

**Files:** Create `src/worker/routes/restaurant.ts`, `src/worker/restaurant.workerd.ts`; modify `src/worker/app.ts` and the matching Fastify route modules only for shared non-HTTP logic.

**Interfaces:** Produce `registerWorkerRestaurantRoutes(app: Hono<WorkerHonoEnv>): void`, covering `/onboarding`, `/restaurants/me`, menu-items CRUD, kitchen reads/status changes, overview, and private table-session reads/close/transfer. Each route consumes the Task 4 auth context and existing owner-scoped services/schemas.

- [ ] **Step 1: Write RED tests.** Assert every private manifest method/path resolves, `equal(noSession.status, 401)`, `equal(crossTenant.status, nodeCrossTenant.status)`, and `equal(menuDelete.status, nodeMenuDelete.status)`. Compare schema error codes and table transfer/close cross-tenant responses with Node.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/restaurant.workerd.ts`; expect absent routes/behavior failures.
- [ ] **Step 3: Implement.** Register the private routes in one focused module; keep ownership decisions in existing service/permission code.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** private business route parity.

### Task 7: Stripe billing and signed webhook

**Files:** Create `src/worker/routes/stripe.ts`, `src/worker/stripe.workerd.ts`; modify `src/worker/app.ts`, `src/modules/billing/stripe/routes.ts`, `src/modules/billing/stripe/webhook-routes.ts` only if shared non-HTTP decisions require extraction.

**Interfaces:** Produce `registerWorkerStripeRoutes(app: Hono<WorkerHonoEnv>): void`, covering checkout, portal, subscription and `/webhooks/stripe`. The webhook passes `await request.text()` unchanged to `constructStripeWebhookEvent`; no generic JSON parse precedes verification.

- [ ] **Step 1: Write RED tests.** Assert `equal(noSession.status, 401)`, `equal(invalidSignature.status, 401)`, `equal(verifiedRawBody, formattedPayload)`, `equal(duplicateSideEffectCalls, 0)`, and `equal(directResendCalls, 0)`. Verify the real Stripe SDK accepts the synthetic signed payload; compare wrong content type/malformed JSON, owner checks, idempotency, durable email intent, and retry response with Node, including no secret in the body.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/stripe.workerd.ts`; expect absent routes/behavior failures.
- [ ] **Step 3: Implement.** Reuse Stripe services/repositories and real signature verification with synthetic test secret; fake persistence/provider calls only after verification. Preserve the Fastify route behavior.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** Stripe HTTP parity.

### Task 8: Mercado Pago OAuth, order payment and signed webhook

**Files:** Create `src/worker/routes/mercado-pago.ts`, `src/worker/mercado-pago.workerd.ts`; modify `src/worker/app.ts`, `src/modules/payments/routes.ts`, `src/modules/payments/providers/mercado-pago/routes.ts`, `src/modules/payments/providers/mercado-pago/webhook-routes.ts` only for shared route decisions.

**Interfaces:** Produce `registerWorkerMercadoPagoRoutes(app: Hono<WorkerHonoEnv>): void` for manual confirmation, hosted checkout, sandbox diagnostics, OAuth connect/status/disconnect/callback, browser return, the canonical signed webhook and its compatibility alias. Reuse the existing payment module, OAuth service, HMAC verifier, return-URL rules, and provider state machine.

- [ ] **Step 1: Write RED tests.** Assert `equal(disabledOAuth.status, 404)`, `equal(productionDiagnostics.status, 404)`, `equal(manualWithoutMercadoPago.status, nodeManual.status)`, `equal(verifiedRawBody, formattedPayload)`, and `equal(duplicateProviderCalls, 0)`. Compare OAuth/browser redirects, checkout token/idempotency, both signed webhook paths, wrong/missing signature, and non-JSON content type with Node.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/mercado-pago.workerd.ts`; expect absent routes/behavior failures.
- [ ] **Step 3: Implement.** Add the Hono adapter; extract shared origin/redirect helpers from Fastify files rather than copying policy logic. Fake external payment calls in `workerd`, not signature verification.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** payment/OAuth/webhook parity.

### Task 9: R2 menu images, ingest and payment-effect admin route

**Files:** Create `src/worker/routes/misc.ts`, `src/worker/misc.workerd.ts`, `src/modules/storage/r2-worker.ts`; modify `src/worker/app.ts`, `src/worker/environment.ts`, and the matching Fastify route modules only where shared logic is extracted.

**Interfaces:** Produce `registerWorkerMiscRoutes(app: Hono<WorkerHonoEnv>): void` for image upload URL/delete, `/ingest/order-feedback`, `/ingest/push-subscription`, and `/admin/payments/effects/reprocess`. Produce `createWorkerMenuImageGateway(signing: NonNullable<AppConfig["r2"]>, bucket: R2Bucket): MenuImageGateway`: S3-compatible presign for existing direct `PUT` upload and bucket binding for delete.

- [ ] **Step 1: Write RED tests.** Assert `equal(deleteResponse.status, 204)`, `equal(disabledUpload.status, 404)`, `equal(bucketDeletedKey, expectedKey)`, `equal(realR2Calls, 0)`, and the returned upload method/header/TTL equal Node. Compare ingest token/session rejections. Assert `equal(wrongAdminKey.status, 401)`, `equal(badLimit.status, 400)`, and `equal(validRunCalls, 1)` with a limit at most 100.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/misc.workerd.ts`; expect absent routes/behavior failures.
- [ ] **Step 3: Implement.** Reuse `MenuImageService` and existing S3 presigner behind the gateway, but add a Worker bucket delete adapter. Synthetic signing credentials only in fixture; no credential in Wrangler vars or source. Reuse existing ingest/admin services and validation.
- [ ] **Step 4: Run GREEN.** Focused test, `npm test`, `npm run build`, `npm run build:worker`.
- [ ] **Step 5: Commit** storage/ingest/admin parity.

### Task 10: Scheduled reconciliation, full inventory, CI and handoff

**Files:** Create `src/worker/scheduled.ts`, `src/worker/scheduled.workerd.ts`, `src/worker/inventory.workerd.ts`, `docs/infra-migration-phase-9-api-worker-native.md`; modify `src/worker/index.ts`, `src/worker/test-fixture.ts`, `src/worker/route-contract.ts`, `.github/workflows/ci.yml`, `package.json` only as required for final checks.

**Interfaces:** Produce `runScheduledReconciliation(services: ApiServices): Promise<PaymentEffectReconciliationResult>`; the exported `scheduled` handler invokes it once with the configured batch bound. The final route-inventory test compares the full manifest to the statically registered Hono routes in an enabled fixture, checks externally visible 404s for disabled optional routes, and confirms no Fastify runtime import or Coolify proxy in the production Worker graph.

- [ ] **Step 1: Write RED tests.** Assert `equal(runOnceCalls, 1)`, `ok(requestedLimit <= configuredBatchSize)`, `equal(intervalStarts, 0)`, and a rejected processor makes the scheduled event fail safely. Compare all manifest methods/paths to registered Hono routes (including Better Auth methods and Mercado Pago alias); assert disabled optional requests give 404 and missing production bindings give sanitized 503 rather than routing elsewhere.
- [ ] **Step 2: Run RED.** `npx tsx --test src/worker/scheduled.workerd.ts src/worker/inventory.workerd.ts`; expect missing behavior/inventory differences.
- [ ] **Step 3: Implement.** Complete `scheduled`, CI checks, and a handoff document listing route count, exact commands/results, residual Stage 10 database and Stage 11 R2/parallel prerequisites. Keep Wrangler configs route-/triggerless and unsecreted.
- [ ] **Step 4: Run final GREEN.** `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, `git diff --check`, `git status --short`; record exact exits and test totals. No claim of readiness if any command fails or any route is absent. Verify the Node/Docker path remains unchanged and no Worker deploy happened.
- [ ] **Step 5: Commit** final tests, CI, and handoff; request whole-branch review only after this gate.

## Execution boundary

This plan ends at a local, non-deployed Stage 9 artifact. Stage 10 must separately prove real preview Hyperdrive → Neon/Better Auth transactions and pool lifetime. Stage 11 must provision preview R2 signing secrets/bucket binding, test real preview upload/delete, and compare both APIs in parallel. Production binding and DNS cutover remain separate owner-visible gates.
