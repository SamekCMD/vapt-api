# Worker Auth Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse Better Auth initialization while keeping I/O and authorization request-scoped.

**Architecture:** A stable AsyncLocalStorage dependency bridge fronts invocation-local pools/email/runners. A single-entry engine cache snapshots effective configuration and awaits schema validation. Worker composition opts in; Node keeps its existing runtime.

**Tech Stack:** TypeScript, Node AsyncLocalStorage, Better Auth 1.7.6, Kysely 0.29.6, pg, Hono, workerd.

**Spec:** docs/superpowers/specs/2026-10-07-worker-auth-context-design.md

## Global Constraints

- No deploy, public ingress, DNS, main merge, Paid upgrade, Stripe Live or legacy retirement in this experiment.
- No global real Pool, session/user/authorization cache, weaker CAPTCHA/cookies/password hashing, or schema changes.
- Preserve Better Auth 1.7.6, Kysely 0.29.6 and current pg/Hyperdrive; no dependency installation.
- All work stays in D:/Projetos and production stays private at db882acc-fdfb-41ce-a783-04ec87954872.

## Review Focus

1. Checkout resolves after its operation has ended: release captured client and reject (Task 1).
2. Escaped connection queried by another invocation: reject before I/O (Task 1).
3. Transaction failure during concurrent requests: rollback/release on original owner (Task 1).
4. Old initialization rejects after new configuration succeeds: do not evict new entry (Task 2).
5. Cached engine used after a session is revoked: query session store again and reject (Task 2).

### Task 1: Request-local dependency bridge

**Files:** Create src/worker/auth-context.ts, src/worker/auth-context.test.ts, src/worker/auth-context-fixture.ts, src/worker/auth-context.workerd.ts, wrangler.worker-test-auth-context.jsonc.

**Interfaces:** Consumes Kysely PostgresPool/PostgresPoolClient and AuthEmailService/BackgroundTaskRunner. Produces createWorkerAuthContext(): { dependencies: { pool: PostgresPool; emailService: AuthEmailService; runInBackground: BackgroundTaskRunner }; run<T>(dependencies: WorkerAuthDependencies, work: () => Promise<T>): Promise<T> }; WorkerAuthDependencies has pool/emailService/runInBackground.

- [ ] Write failing tests: concurrent Kysely queries/transactions must label their own client; failed transaction must show BEGIN/query/ROLLBACK/release only for its owner; email promises must reach their own runner. Without a scope, after release, in another scope and after completion, assert rejects with code auth_context_unavailable and zero unauthorized SQL/email calls. A late connect must release exactly once. end must not end any real pool. Cursor input must fail before underlying query.
- [ ] Run `npx tsx --test src/worker/auth-context.test.ts`. Expected: module missing or exported bridge missing (RED).
- [ ] Implement createWorkerAuthContext in src/worker/auth-context.ts. Use one ALS per bridge; finally marks scope inactive; preserve captured client release and optional processID, never credentials/options/Client. Keep unsupported cursor explicit.
- [ ] Run `npx tsx --test src/worker/auth-context.test.ts` and `npm run build`. Expected: all bridge tests pass and build exit 0.
- [ ] Add workerd fixture returning assertions from concurrent Kysely transactions, no/expired-context rejection and email-runner isolation. Run `npx tsx --test src/worker/auth-context.workerd.ts`. Expected: pass with fixture invariants true; no external network.
- [ ] Commit only Task 1 bridge/tests/config/docs: `git commit -m "feat(worker): isolate reusable auth dependencies by invocation"`. Expected: success on codex/infra-foundation, no main changes.

### Task 2: Engine cache and Worker integration

**Files:** Create src/worker/auth-runtime.ts, src/worker/auth-runtime.test.ts and src/worker/auth-retention.gc.ts. Modify src/modules/auth/better-auth.ts, src/composition/api-services.ts, src/worker/services.ts, bridge workerd fixture/test, package.json, .github/workflows/ci.yml and Stage 13 CPU diagnosis.

**Interfaces:** Consumes createWorkerAuthContext. Produces createWorkerAuthRuntimeFactory(options?: { createEngine?: WorkerAuthEngineBuilder }): (config: BetterAuthConfig, dependencies: BetterAuthOptionDependencies, environment: string) => AuthRuntime. Factory is isolate-local and receives environment identity per runtime call through a Worker-bound closure; cache is a sole shared entry. WorkerAuthEngine is { ready: Promise<void>; runtime: AuthRuntime }; builder takes (config, bridgeDependencies). Extend ApiServiceDependencies with optional authRuntimeFactory typed from createBetterAuthRuntime, broaden pool dependency to PostgresPool. Worker supplies reusable factory; explicit authRuntime override wins; Node fallback stays original.

- [ ] Write failing cache tests using a constructor seam only at engine creation: reuse same immutable config, initialize once across overlap; change each config field/environment and assert new engine; mutate caller config and assert snapshot stable; rejected initialization retries; stale rejection cannot evict current engine; session errors do not invalidate readiness. Use real Better Auth + memoryAdapter for valid/revoked/invalid-session Cookie, asserting revoked next call is null.
- [ ] Run `npx tsx --test src/worker/auth-runtime.test.ts`. Expected: missing factory (RED).
- [ ] Implement factory/cache in src/worker/auth-runtime.ts. Keep constructor seam explicit for tests; default uses betterAuth(createBetterAuthOptions), awaits $context and checkSchema. Store no request dependency in cache entry. Snapshot comparison lists every config field; no logs/JSON keys. Runtime.close no-op.
- [ ] Add failing composition assertion that Worker chooses its reusable factory lazily while explicit runtime/factory overrides and Node behavior are preserved. Run named test file. Expected: fails before wiring.
- [ ] Wire optional authRuntimeFactory and Worker-bound environment identity; run tests and build. Expected: pass, existing anonymous guard and session/cookie contracts unchanged.
- [ ] Expand workerd fixture to execute real default engine with unrelated/invalid Cookie without external SQL (schema metadata synthetic network boundary if necessary); do not disable schema validation. Run targeted workerd test. Expected: isolated engine survives reuse and negatives remain null.
- [ ] Add regression `late descendant promises cannot retain or reuse the completed invocation dependencies` with a pending callback created during initialization and WeakRefs of the first pool/email/runner. Assert all three collected while callback is pending, then callback rejects auth_context_unavailable. Run `npm run test:auth-retention` (node --expose-gc --test-isolation=none --import tsx --test src/worker/auth-retention.gc.ts). Expected: RED before scope references clear; GREEN after. Wire dedicated script into CI because normal Node test isolation omits the GC flag.
- [ ] Run `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, preserving logs in this plan's scratch. Expected: all pass, dry-run only. Record CPU Free remains unapproved and no remote deployment.
- [ ] Commit Task 2 code/tests/evidence: `git commit -m "perf(worker): reuse auth engine without sharing request I/O"`. Expected: success on feature branch only.

## Final gate

One fresh-context review of this experiment's complete range, not the already-reviewed historical migration commits. Address Critical/Important findings with RED/GREEN and full verification; ledger Minor. No merge, push or deploy implied by local completion.
