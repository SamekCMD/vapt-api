# Vapt API Stage 10: Hyperdrive → Neon Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the native Cloudflare API Worker reaches the existing Neon `preview.vapt` database through real Hyperdrive, with safe connection lifetime, transactions, Better Auth persistence, and preview-only least privilege. Do not move traffic.

**Architecture:** Retain `pg`, `Database`, Kysely and Better Auth. A single request-scoped `pg.Pool` factory serves both the production entrypoint and a separate authenticated, fixed-operation diagnostic entrypoint. The diagnostic runs temporarily with `wrangler dev --remote` against a cache-disabled Hyperdrive configuration targeting the direct Neon preview endpoint. Versioned grants live in the parent Vapt repository; Worker code lives in the nested API repository.

**Tech Stack:** TypeScript/Node 24, `pg@8.23.0`, Kysely `0.29.6`, Better Auth `1.7.6`, Wrangler `4.138.0`, Cloudflare Workers/Hyperdrive, Neon Postgres, `tsx --test`, `workerd` harness, PostgreSQL SQL verification.

**Spec:** `docs/superpowers/specs/2026-09-29-vapt-api-hyperdrive-neon-preview-design.md` (approved 2026-09-29). Source migration plan: parent repository `docs/infra-migration-plan.md`, Stage 10.

## Global Constraints

- API repository/worktree: `D:/Projetos/vaptmesaflow/.worktrees/vapt-api-infra-foundation`. Parent repository: `D:/Projetos/vaptmesaflow`. Preserve the parent's pre-existing untracked `docs/implementation-references/`. Commit changes in the correct repository; do not copy SQL into the API repo merely to make one commit.
- Only Neon project `dawn-morning-27332079`, branch `preview` (`br-rough-dew-b6ydeygb`), database `vapt` may receive Stage 10 changes. Check identity before every remote mutation. Production branch `br-odd-term-b6j2n9ms` is read-only for this stage. Coolify remains live; do not change DNS, routes, Cron, Vercel, R2, provider credentials, Stripe Live, or the production Hyperdrive binding.
- No secret, complete connection string, synthetic session token/password, or recipient address in Git, shell arguments/history, command output, test snapshots, handoff, or logs. Use secure UI/credential input and redact diagnostic output. Never run a command that prints the database URI. Use `wrangler dev --remote`; ordinary local `wrangler dev` cannot establish Hyperdrive acceptance.
- The preview diagnostic has no arbitrary SQL, caller-provided URL, email, recipient or provider operation. Gate every operation before opening a database connection with a random secret stored outside Git. Return only fixed pass/fail and non-sensitive identity fields, with `Cache-Control: no-store`; do not introduce a permanent production route.
- Keep `pg.Pool` invocation-local, initially `max: 1`; never share a pool/client globally. Do not introduce `.end()` or another lifecycle policy without remote evidence. Keep production HTTP behavior and `withTransaction` semantics unchanged. If real `pg`/Kysely/Better Auth behavior is incompatible, stop and revise the approved design before changing drivers.
- Before each remote test, confirm Hyperdrive target is the *direct* preview endpoint, not Neon `-pooler`, caching is disabled, and the dedicated preview role cannot create schema objects. Stop if identity cannot be proven. Synthetic writes are preview-only, have bounded cleanup, and cannot trigger provider calls.
- Work in small TDD increments: record the failing assertion, run focused tests red, implement minimally, run focused and cumulative tests green, inspect diff, commit. Test doubles and local workerd tests are preparation, not proof of a live Hyperdrive connection.

## Review Focus

1. Wrong/missing binding or target must fail closed, not reach production: Task 1's `rejects missing Hyperdrive` test and Tasks 5–6's preview identity assertions.
2. A low-privilege role must support normal API/auth DML but deny DDL and unintended function access: Task 2's positive/negative SQL verifier.
3. Repeated/concurrent invocations must not reuse a stale global client, hang, or exhaust origin connections: Task 1's distinct-pool test and Task 7's remote lifetime check.
4. A synthetic Better Auth session must resolve across invocations, then disappear after revocation, without email/Turnstile contact: Task 4's focused tests and Task 7's remote check.
5. Unauthenticated/unsupported diagnostic input must cause zero database or provider calls and reveal no secrets: Task 3's contract tests and Task 8's scheduled guard test.

---

### Task 1: Establish local baseline and request-scoped pool factory

**Files (API repo):** Create `src/worker/database.ts`, `src/worker/database.test.ts`; modify `src/worker/services.ts`; optionally extend `src/worker/environment.test.ts`.

**Interfaces:** `createWorkerDatabase(env: Pick<WorkerBindings, "HYPERDRIVE">): Pool` validates the binding before constructing `new Pool({ connectionString, max: 1 })`; `createWorkerServices` calls it only when no database override is provided. No global variable stores the pool. The existing `Database` interface and Better Auth pool contract stay unchanged.

- [ ] **Step 1: Baseline:** In the API repo run `git status --short`, `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, and `git diff --check`. Record counts and failures; do not disguise a pre-existing failure as Stage 10 work.
- [ ] **Step 2: Write failing tests** named `rejects missing Hyperdrive without secret echo`, `creates distinct max-one pools`, and `honors injected database`. Assert a missing binding throws `/HYPERDRIVE/` but not a sentinel password; `createWorkerDatabase(env)` twice yields `notStrictEqual` and each `pool.options.max === 1`; the injected `database` is returned unchanged by `createWorkerServices`.
- [ ] **Step 3: Run RED:** `npx tsx --test src/worker/database.test.ts`; expect the new factory import/assertion to fail, not a network error.
- [ ] **Step 4: Implement** `createWorkerDatabase(env: Pick<WorkerBindings, "HYPERDRIVE">): Pool` and wire `createWorkerServices` to it only without an override. Do not add a global singleton or change request/scheduled entrypoints.
- [ ] **Step 5: Run GREEN:** Focused test, `npm test`, `npm run test:worker`, `npm run build`, and `npm run build:worker` all exit 0.
- [ ] **Step 6: Commit** only the pool boundary and tests in the API repo.

### Task 2: Version preview-only SQL grants and negative verification

**Files (parent repo):** Create `infra/neon/006_worker_preview_role_grants.sql`, `infra/neon/verify-worker-preview-role.sql`; update `docs/infra-migration-phase-4-neon.md` only with verified, non-secret facts after application.

**Interfaces:** The migration grants `CONNECT` on `vapt`, `USAGE` on required schemas, and the minimum table/sequence/function privileges actually used by the API and Better Auth to a dedicated `vapt_api_preview` role; it does not grant ownership or `CREATE`. The verifier checks branch/database/user and positive/negative ACLs, including denied DDL, with no production target. Role credential creation itself is out-of-band and never appears in SQL.

- [ ] **Step 1: Inventory:** Read current preview role/schema ACLs and API query/function inventory. Confirm project ID, preview branch ID, `current_database()`, and direct endpoint metadata without printing connection strings. Inspect `001`–`005` migrations and Better Auth schema before defining grants. Do not execute production writes.
- [ ] **Step 2: RED:** Draft the verifier first. On preview, demonstrate the dedicated role is absent or cannot perform the required read/write/auth operations and that DDL is denied. If role creation is needed to make the RED check meaningful, create it only in the verified preview branch through secure input, without granting application access yet.
- [ ] **Step 3: GREEN:** Apply reviewed, idempotent grant SQL to preview only using a direct administrative connection. Run verifier as the dedicated role: permitted `public` and `better_auth` operations succeed; `CREATE TABLE`, schema creation/alteration and unrelated privileges fail. Confirm no production role or schema change; never include the credential in output.
- [ ] **Step 4: Commit** SQL and verified non-secret handoff notes in the parent repository, leaving unrelated untracked files untouched. If verification cannot be automated safely, stop and document exact manual result before advancing.

### Task 3: Build a contained diagnostic Worker with local contract tests

**Files (API repo):** Create `src/worker/hyperdrive-probe.ts`, `src/worker/hyperdrive-probe.test.ts`, `src/worker/hyperdrive-probe.workerd.ts`, `wrangler.worker-probe-test.jsonc`, `wrangler.worker-probe-preview.jsonc`; modify `src/worker/environment.ts` only if a typed probe-only secret binding is required. Do not modify production route registration.

**Interfaces:** `handleHyperdriveProbe(request: Request, env: ProbeBindings, dependencies: ProbeDependencies): Promise<Response>` dispatches an allowlist of fixed operations (`identity`, `query`, `transaction`, `auth/create`, `auth/read`, `auth/revoke`, `reconcile`). `ProbeBindings = Pick<WorkerBindings, "ENVIRONMENT" | "HYPERDRIVE"> & { PROBE_TOKEN?: string }`; `ProbeDependencies` injects the database factory and fixed operation runner for tests. It requires a constant-time comparison against `PROBE_TOKEN` or equivalent random secret before constructing the pool; it rejects absent/invalid token, method, operation and environment with sanitized 4xx/5xx. The preview config contains only non-secret environment metadata and, once provisioned, a Hyperdrive binding ID; no `localConnectionString`, routes, triggers or `workers_dev` deployment. Avoid embedding fake production credentials in the remote config.

- [ ] **Step 1: Write failing tests** named `denies before database creation`, `rejects unsupported operation`, and `requires preview environment`. For a missing/wrong token, unsupported operation, or `ENVIRONMENT=production`, assert 4xx/5xx, `databaseFactoryCalls === 0`, no sentinel secret in response, and `cache-control === "no-store"`. In workerd, assert the diagnostic entrypoint does not serve `/auth/me` or another production route.
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/hyperdrive-probe.test.ts src/worker/hyperdrive-probe.workerd.ts`; expect the new assertions to fail.
- [ ] **Step 3: Implement** `handleHyperdriveProbe(request: Request, env: ProbeBindings, dependencies: ProbeDependencies): Promise<Response>`; define `ProbeBindings` as preview environment, `HYPERDRIVE`, and optional `PROBE_TOKEN`. Dispatch only fixed operation names after token comparison. Keep the real entrypoint separate from `src/worker/index.ts`; add `no-store` and sanitized errors.
- [ ] **Step 4: Run GREEN:** Focused tests, `npm run test:worker`, and `npx wrangler deploy --dry-run --config wrangler.worker-probe-test.jsonc` exit 0.
- [ ] **Step 5: Commit** the contained scaffold and tests. The remote config must remain inoperable without its out-of-Git secret and later Hyperdrive ID.

### Task 4: Implement fixed SQL, transaction and Better Auth probes locally

**Files (API repo):** Modify `src/worker/hyperdrive-probe.ts` and focused tests; create `src/worker/hyperdrive-probe-operations.ts`, `src/worker/hyperdrive-probe-operations.test.ts`; add a local-only test fixture if necessary, never one containing a real credential.

**Interfaces:** The fixed operations use `createWorkerDatabase`, existing `withTransaction`, and the existing `createBetterAuthRuntime`/`AuthRuntime`, not a second driver. `identity` reports only expected database/user; `query` includes a parameterized query; `transaction` tests rollback absence and commit/read-after-write followed by cleanup. `auth` uses a synthetic preview-only identity/session, injected no-op email and synthetic Turnstile context, carries its opaque test token only in memory across distinct invocations, resolves with `getSession`, then revokes/cleans it. Each operation has a bounded timeout/cleanup path and no raw DB error in HTTP responses.

- [ ] **Step 1: Write failing tests** named `uses bound parameters`, `rollback leaves no row`, `commit is visible then cleaned`, `session survives fresh runtime`, and `revoked session is absent`. Assert the query passes values separately from SQL text, both cleanup paths leave zero tagged rows, a second `AuthRuntime.getSession` returns the synthetic user, a third returns `null` after revocation, and fake email/provider call counts stay zero.
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/hyperdrive-probe-operations.test.ts`; retain the first relevant failing assertion.
- [ ] **Step 3: Implement** fixed operations using `createWorkerDatabase`, `withTransaction(database: Database, work)`, and `createBetterAuthRuntime(config, dependencies)`. Use an ephemeral synthetic test token held only in memory; never return it in logs. If Better Auth cannot resolve a seeded session through its real runtime, stop and determine the actual session contract rather than bypassing `AuthRuntime` or weakening production auth.
- [ ] **Step 4: Run GREEN:** Focused Node/workerd tests, full `npm test`, `npm run test:worker`, `npm run build`, and `npm run build:worker` exit 0.
- [ ] **Step 5: Commit** probe operations and tests. No live resource or production code route is enabled by this commit.

### Task 5: Provision and verify the preview Hyperdrive binding

**Files (API repo):** Modify `wrangler.worker-probe-preview.jsonc` with preview Hyperdrive ID only. **External:** Neon preview role and Cloudflare preview Hyperdrive resource only.

**Interfaces:** Hyperdrive `HYPERDRIVE` targets the role's direct Neon `preview.vapt` endpoint with query caching disabled. The ID is non-secret, but the endpoint credential never enters the config or Git.

- [ ] **Step 1: RED/preflight:** Confirm verified preview role, direct host (no `-pooler`), database name, Neon branch ID, Cloudflare account, cache-disabled setting, and absence of a same-name conflicting Hyperdrive config. Capture non-secret metadata only. If secure credential input cannot avoid shell arguments/history/logging, use the authenticated UI or stop; do not paste a URI into commands.
- [ ] **Step 2: Create** a single preview Hyperdrive config. Inspect its returned target metadata and cache state before writing its ID to the probe Wrangler config. Do not create a production config or attach this ID to production.
- [ ] **Step 3: Verify** the binding's Cloudflare target metadata, cache state, and preview-only role against the preflight inventory; run a Wrangler probe-config dry-run. If the target cannot be established without printing credentials, stop.
- [ ] **Step 4: Commit** only the safe binding ID/config in the API repo. Resource creation is not remote acceptance.

### Task 6: Real Hyperdrive SQL and transaction proof

**Files (API repo):** Optionally create `scripts/verify-hyperdrive-preview.mjs` and focused tests for its response assertions; modify fixed diagnostic operations only for demonstrated defects.

**Interfaces:** A temporary `wrangler dev --remote` session runs the diagnostic entrypoint. A verifier retains `PROBE_TOKEN` only in memory, emits sanitized pass/fail and non-sensitive identity metadata, and stops the session in `finally`.

- [ ] **Step 1: Write failing verifier tests** named `rejects wrong preview identity`, `rejects failed transaction`, and `redacts secret`. Assert database `!== "vapt"` or user `!== "vapt_api_preview"` fails; `rollbackAbsent !== true`, `committedVisible !== true`, or `cleaned !== true` fails; output excludes sentinel token. Assert missing cache-disabled resource metadata fails preflight.
- [ ] **Step 2: Run RED:** `npx tsx --test scripts/verify-hyperdrive-preview.test.mjs`; expect the new assertion to fail.
- [ ] **Step 3: Implement** `scripts/verify-hyperdrive-preview.mjs` as a fixed-response validator with no credential printing; run the focused test green. Verify production Worker still fails closed without its own binding and probe config has no route/Cron.
- [ ] **Step 4: Remote:** Start the diagnostic with an out-of-Git secret. Verify unauthorized access fails before DB use; then prove real Hyperdrive identity, parameterized query, rollback absence, commit/read-after-write and cleanup. Stop on first unexplained failure. Local `wrangler dev` and dry-run do not satisfy this step.
- [ ] **Step 5: Commit** sanitized verifier code/results in the API repo; keep the session token, credential and raw connection string out of the commit.

### Task 7: Remote Better Auth and connection-lifetime proof

**Files (API repo):** Modify focused diagnostic tests/code only for demonstrated defects; capture non-secret observations in the Stage 10 handoff.

**Interfaces:** The same remote diagnostic verifies a synthetic Better Auth session via real `AuthRuntime` in a separate invocation, revokes it, and checks it is absent later. Repeated and limited concurrent invocations use the same request-scoped factory without retaining clients or timers.

- [ ] **Step 1: Remote auth:** Create only synthetic preview identity/session data, resolve with `getSession` from a new invocation, revoke, and verify absence. Confirm no outbound email or provider call. If it fails, inspect the actual Better Auth schema/session contract and stop before altering production auth.
- [ ] **Step 2: Remote lifetime:** Repeat fresh invocations and a small bounded concurrent batch; observe completion times, errors and Hyperdrive/Neon connection metrics without exposing SQL or secrets. Require no stale socket, leaked checkout, hanging pool timer or unbounded origin connection. If `Pool(max:1)` or cleanup fails, stop and revise the design.
- [ ] **Step 3: Verify/commit:** Re-run focused and cumulative local tests/builds after any code change, and commit a focused fix only with an observed red/green regression. If no code change is needed, record the remote evidence for Task 8 without manufacturing a commit.

### Task 8: Bounded scheduled proof, final gates and handoff

**Files (API repo):** Create `docs/infra-migration-phase-10-hyperdrive-neon-preview.md`; adjust only focused tests/code if a demonstrated defect requires it. **Files (parent repo):** Update `docs/infra-migration-phase-4-neon.md` with final grants/resource metadata as applicable.

**Interfaces:** One fixed diagnostic `reconcile` operation invokes the existing `runScheduledReconciliation` for a single bounded pass only after verifying no eligible payment-effect work exists in preview; no provider calls or interval start. Full production entrypoint remote smoke is optional and is skipped unless its temporary URL can be restricted *before* any request. Coolify stays the serving API.

- [ ] **Step 1: Write failing tests** named `refuses nonempty eligible outbox` and `runs one bounded reconciliation`. Assert nonempty eligible count returns a denied result with zero `runOnce`/provider calls; empty count yields exactly one `runOnce` call with a limit between 1 and 100, zero `start`/interval calls, and zero provider calls.
- [ ] **Step 2: Run RED:** `npx tsx --test src/worker/hyperdrive-probe-operations.test.ts`; expect the new reconciliation assertion to fail.
- [ ] **Step 3: Implement and run GREEN:** Add the fixed `reconcile` operation, using existing `runScheduledReconciliation(services: ApiServices)`, after the eligible-outbox guard. Run the focused test plus `npm test` and `npm run test:worker`; require exit 0.
- [ ] **Step 4: Remote scheduled-equivalent:** Recheck preview identity and empty eligible outbox. Execute one bounded pass via the authenticated diagnostic; confirm no side effect or timer and inspect sanitized result. Do not install a Cron trigger.
- [ ] **Step 5: Cleanup:** Revoke/delete synthetic Better Auth session/user and transaction rows, verify their absence, stop the remote-dev process, clear the temporary probe secret, and record whether the preview Hyperdrive/role are retained for Stage 11. If target or grants are wrong, disable/revoke preview resources only; never touch production.
- [ ] **Step 6: Final verification:** In API repo run focused tests, `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`, probe dry-run, `git diff --check`, and inspect `git status`. In parent repo run SQL verifier and `git diff --check`; document any unrun gate explicitly. Scan tracked diff for credentials/connection strings and confirm no route, DNS, Cron, provider, Coolify or production resource mutation.
- [ ] **Step 7: Handoff and review:** Document non-secret project/branch/database/role/Hyperdrive IDs, exact tests and results, remote lifecycle observations, cleanup, limitations and Stage 11 prerequisite. Review the whole branch against this plan and spec, fix P0/P1 findings with focused tests, then commit the final handoff separately in the owning repo.

## Completion gate

Stage 10 is complete only when all six remote acceptance criteria in the approved spec have direct evidence. A synthetic workerd pass, Wrangler packaging pass or health response is not completion. Report a precise blocker and leave Coolify serving if any gate cannot be met; do not infer permission for production cutover or Stage 11 traffic.
