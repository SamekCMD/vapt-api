# Worker Auth Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

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

- [x] Write failing tests: concurrent Kysely queries/transactions must label their own client; failed transaction must show BEGIN/query/ROLLBACK/release only for its owner; email promises must reach their own runner. Without a scope, after release, in another scope and after completion, assert rejects with code auth_context_unavailable and zero unauthorized SQL/email calls. A late connect must release exactly once. end must not end any real pool. Cursor input must fail before underlying query.
- [x] Run `npx tsx --test src/worker/auth-context.test.ts`. Expected: module missing or exported bridge missing (RED).
- [x] Implement createWorkerAuthContext in src/worker/auth-context.ts. Use one ALS per bridge; finally marks scope inactive; preserve captured client release and optional processID, never credentials/options/Client. Keep unsupported cursor explicit.
- [x] Run `npx tsx --test src/worker/auth-context.test.ts` and `npm run build`. Expected: all bridge tests pass and build exit 0.
- [x] Add workerd fixture returning assertions from concurrent Kysely transactions, no/expired-context rejection and email-runner isolation. Run `npx tsx --test src/worker/auth-context.workerd.ts`. Expected: pass with fixture invariants true; no external network.
- [x] Commit only Task 1 bridge/tests/config/docs: `git commit -m "feat(worker): isolate reusable auth dependencies by invocation"`. Expected: success on codex/infra-foundation, no main changes.

### Task 2: Engine cache and Worker integration

**Files:** Create src/worker/auth-runtime.ts, src/worker/auth-runtime.test.ts and src/worker/auth-retention.gc.ts. Modify src/modules/auth/better-auth.ts, src/composition/api-services.ts, src/worker/services.ts, bridge workerd fixture/test, package.json, .github/workflows/ci.yml and Stage 13 CPU diagnosis.

**Interfaces:** Consumes createWorkerAuthContext. Produces createWorkerAuthRuntimeFactory(options?: { createEngine?: WorkerAuthEngineBuilder }): (config: BetterAuthConfig, dependencies: BetterAuthOptionDependencies, environment: string) => AuthRuntime. Factory is isolate-local and receives environment identity per runtime call through a Worker-bound closure; cache is a sole shared entry. WorkerAuthEngine is { ready: Promise<void>; runtime: AuthRuntime }; builder takes (config, bridgeDependencies). Extend ApiServiceDependencies with optional authRuntimeFactory typed from createBetterAuthRuntime, broaden pool dependency to PostgresPool. Worker supplies reusable factory; explicit authRuntime override wins; Node fallback stays original.

- [x] Write failing cache tests using a constructor seam only at engine creation: reuse same immutable config, initialize once across overlap; change each config field/environment and assert new engine; mutate caller config and assert snapshot stable; rejected initialization retries; stale rejection cannot evict current engine; session errors do not invalidate readiness. Use real Better Auth + memoryAdapter for valid/revoked/invalid-session Cookie, asserting revoked next call is null.
- [x] Run `npx tsx --test src/worker/auth-runtime.test.ts`. Expected: missing factory (RED).
- [x] Implement factory/cache in src/worker/auth-runtime.ts. Keep constructor seam explicit for tests; default uses betterAuth(createBetterAuthOptions), awaits $context and checkSchema. Store no request dependency in cache entry. Snapshot comparison lists every config field; no logs/JSON keys. Runtime.close no-op.
- [x] Add failing composition assertion that Worker chooses its reusable factory lazily while explicit runtime/factory overrides and Node behavior are preserved. Run named test file. Expected: fails before wiring.
- [x] Wire optional authRuntimeFactory and Worker-bound environment identity; run tests and build. Expected: pass, existing anonymous guard and session/cookie contracts unchanged.
- [x] Expand workerd fixture to execute real default engine with unrelated/invalid Cookie without external SQL (schema metadata synthetic network boundary if necessary); do not disable schema validation. Run targeted workerd test. Expected: isolated engine survives reuse and negatives remain null.
- [x] Add regression `late descendant promises cannot retain or reuse the completed invocation dependencies` with a pending callback created during initialization and WeakRefs of the first pool/email/runner. Assert all three collected while callback is pending, then callback rejects auth_context_unavailable. Run `npm run test:auth-retention` (node --expose-gc --test-isolation=none --import tsx --test src/worker/auth-retention.gc.ts). Expected: RED before scope references clear; GREEN after. Wire dedicated script into CI because normal Node test isolation omits the GC flag.
- [x] Run `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, preserving logs in this plan's scratch. Expected: all pass, dry-run only. Record CPU Free remains unapproved and no remote deployment.
- [x] Commit Task 2 code/tests/evidence: `git commit -m "perf(worker): reuse auth engine without sharing request I/O"`. Expected: success on feature branch only.

## Final gate

One fresh-context review of this experiment's complete range, not the already-reviewed historical migration commits. Address Critical/Important findings with RED/GREEN and full verification; ledger Minor. No merge, push or deploy implied by local completion.

## Execution record and closing rulings

Task 1 complete: 36d76df; baseline498/498, RED missing module, GREEN bridge6/6 and workerd1/1. Task 2 complete: e9aa582; RED missing runtime module and ignored composition factory; GC RED retained3/3 dependencies in pending descendant, GREEN collected3/3 and rejected late I/O. Final API514/514, workerd20/20, GC1/1, build exit0, production guard7/7+CLI, production dry-run4490.24KiB/gzip766.39KiB without upload. Original checklists below are now completed; this record retains exact evidence independently of scratch cleanup.

Fresh independent final review of the entire experiment72dec1d..e9aa582: no Critical/Important/Minor. Local experiment accepted, not a production/CPU gate. Node GC settled readiness promises alone did not reproduce a leak; pending descendants did. No new cloud operation, push, main merge, Paid or credential change. Existing migration worktree/PR preserved because Stage13 is incomplete.

- Ruling: Execute local design/plan inline under repeated explicit direct-execution authorization, without another design approval question — matches the user's selected workflow — if wrong, discard the local experiment; no external activation authority inferred.
- Final Ruling: Real Neon/Hyperdrive transport, schema and transactions remain a private integration gate — synthetic SQL cannot certify them — if assumed complete, database operations may fail.
- Final Ruling: Positive-session PostgreSQL behavior remains a separate private gate — positive/revoked sessions used memoryAdapter and the default PostgreSQL tests used signed unknown tokens — if assumed complete, legitimate users may be denied or session behavior may differ.
- Final Ruling: Separate Cloudflare invocation I/O lifetime remains a private gate — workerd overlapped logical operations in one fixture request, not actual request-bound Hyperdrive I/O across invocations — if assumed complete, cross-request I/O can fail despite correct logical ownership.
- Final Ruling: CPU Free/password/login suitability remains unapproved — no new remote measurement — if assumed complete, requests may exceed CPU limits; Paid is not authorized as a workaround.
- Final Ruling: Browser cookies/CORS and provider delivery remain their existing gates — local lifetime tests do not certify them — if assumed complete, login or emails/payment effects may fail.
- Final Ruling: Historical migration and public production readiness remain outside this new-range review — preserve earlier evidence and unfinished gates — if assumed complete, cutover risks remain unexamined.

Deferred minors: none in this experiment. Historical anonymous-guard missing-factory503 test Minor remains deferred; not reopened by this review.
