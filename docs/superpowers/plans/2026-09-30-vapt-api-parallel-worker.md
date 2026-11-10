# Vapt API Stage 11 Parallel Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete API on an Access-protected Cloudflare Preview against isolated Neon/R2 preview resources, compare safe HTTP contracts with Coolify, and prepare—but do not connect—a limited production Neon role and Hyperdrive.

**Architecture:** A dedicated route-less Worker owns a Preview whose entrypoint checks a Preview-only bearer before delegating to the existing API Worker. The Preview declares its own bindings and secrets; Coolify remains the public API. Production database readiness is a separate parent-repository SQL/resource track with no Worker binding or traffic.

**Tech Stack:** TypeScript 5.8, Node >=24, Hono, Wrangler 4.138.0/workerd, Cloudflare Access/Workers Previews/Hyperdrive/R2, Neon PostgreSQL, Better Auth 1.7.6, Stripe Test Mode.

**Spec:** `docs/superpowers/specs/2026-09-30-vapt-api-parallel-worker-design.md`

## Global Constraints

- Work in API checkout `D:\Projetos\vaptmesaflow\.worktrees\vapt-api-infra-foundation`; only production-role SQL and parent handoff belong in `D:\Projetos\vaptmesaflow`. Preserve unrelated and untracked user files.
- Cloudflare account `3ce69408aa5112617a282957aba71932`; existing Preview Hyperdrive `0c05fec2924b4f3b9225f3d689ba7ea9` targets direct Neon preview `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech`, database `vapt`, role `vapt_api_preview`, cache disabled, origin limit 5.
- Neon project `dawn-morning-27332079`: preview `br-rough-dew-b6ydeygb`; production `br-odd-term-b6j2n9ms`. Do not copy identities, UUIDs, sessions, billing events, or objects between branches.
- Preview only: `ENVIRONMENT=preview`, R2 `vapt-assets-preview`, six separate rate-limit namespaces, Stripe **test**, Turnstile test, restricted Resend; never use production Hyperdrive/R2 or a `DATABASE_URL` fallback.
- No public route, DNS change, Coolify edit, Cron/Queue consumer, Stripe Live/Mercado Pago live request, frontend browser-cookie claim, realtime claim, or API cutover. Vercel/Easypanel are legacy.
- Never put passwords, bearer/service tokens, complete connection URIs, signed R2 URLs, or provider secrets in Git, CLI arguments, logs, test output, or the handoff. Test email only to `delivered@resend.dev`.
- Stop before full-route exposure unless Worker-specific `preview_worker` Access is attached and an unauthenticated request is denied at the edge. On failure, keep the route-less shell; do not create a public bypass.

## Review Focus

1. A missing/duplicated/malformed bearer header or absent secret must produce sanitized `401`/`503` with `no-store` **before** the API fetch handler runs (Task 1 test).
2. A Preview URL with a silently missing or production binding must fail configuration inspection; no `production` resource may be present (Task 2 test).
3. An Access policy that targets `worker`, `all_preview_workers`, or the frontend instead of this Worker's `preview_worker` destination must block deployment (Task 3 check).
4. An R2 signed upload with changed key, MIME, length, or expired TTL must not create an object; a successful test must leave no object (Task 6 test).
5. A production role that inherits ownership/admin power or can read excluded tables must fail verification even if ordinary DML succeeds (Task 7 verifier and negative privilege test).

---

### Task 1: Fail-closed Preview ingress

**Files:** Create `src/worker/parallel-preview.ts`, `src/worker/parallel-preview.test.ts`; leave `src/worker/index.ts` unchanged.

**Interfaces:** Consume `WorkerBindings` from `environment.ts` and the default `fetch(request, env, context)` from `index.ts`. Produce `handleParallelPreview(request: Request, env: WorkerBindings & { PARALLEL_PREVIEW_TOKEN?: string }, context: ExecutionContext, delegate?: typeof apiWorker.fetch): Promise<Response>` and a default Worker export with `fetch` only—no `scheduled` handler.

- [ ] **Step 1: Write failing tests** for missing/wrong/duplicate/oversized `Authorization: Bearer` header, missing token secret, and `ENVIRONMENT=production`; assert status `401` (or `503` for missing secret/wrong environment), `cache-control: no-store`, generic body, and delegate call count zero. Assert valid token delegates exactly once with the gate header removed and preserves method/body/cookies; a later app error must not expose the token.
- [ ] **Step 2: Run** `npx tsx --test src/worker/parallel-preview.test.ts`; expect RED because the handler is absent.
- [ ] **Step 3: Implement** `handleParallelPreview` using Web Crypto digest and fixed-size comparison, reject before config/service use, and clone the request without `Authorization` before delegating. Do not log credentials or change the existing public entrypoint.
- [ ] **Step 4: Run** the focused test, `npm test`, and `npm run build`; expect all PASS.
- [ ] **Step 5: Commit** only the two new files as `feat: gate parallel API Preview before app dispatch`.

### Task 2: Explicit Preview configuration and static isolation check

**Files:** Create `wrangler.worker-parallel-preview.jsonc`, `scripts/verify-parallel-preview-config.mjs`, `scripts/verify-parallel-preview-config.test.mjs`.

**Interfaces:** The config uses Worker name `vapt-api-parallel`, `main: src/worker/parallel-preview.ts`, `workers_dev: false`, `preview_urls: false`, no routes/triggers/production bindings at top level. Its `previews` block declares `ENVIRONMENT=preview`, `HYPERDRIVE` ID `0c05fec2924b4f3b9225f3d689ba7ea9`, `R2_BUCKET` = `vapt-assets-preview`, and `AUTH_RATE_LIMIT`, `BILLING_RATE_LIMIT`, `ORDERS_RATE_LIMIT`, `STORAGE_RATE_LIMIT`, `WEBHOOKS_RATE_LIMIT`, `PUBLIC_RATE_LIMIT` with distinct Preview `namespace_id`s and existing policy limits 20/60/30/30/300/120 per 60 seconds. Export `assertParallelPreviewConfig(config: object): void` from the verifier. Pick unused namespace IDs only after account inventory; record the chosen six in this file before any Preview deployment.

- [ ] **Step 1: Write failing tests** that reject missing `previews` bindings, shared rate-limit namespace IDs, top-level production resources, `ENVIRONMENT=production`, routes/Cron/queues, or a literal secret/`DATABASE_URL`; accept the exact preview resource names above.
- [ ] **Step 2: Run** `node --test scripts/verify-parallel-preview-config.test.mjs`; expect RED.
- [ ] **Step 3: Implement** the JSONC config and `assertParallelPreviewConfig`, checking a parsed config without printing values. Keep secret names out of `vars`; use Preview secrets for `PARALLEL_PREVIEW_TOKEN`, Better Auth, R2 signing, Stripe Test, Turnstile, and Resend values. Keep non-secret app URLs, plan IDs and template IDs in `previews.vars` only after checking their target.
- [ ] **Step 4: Run** the focused test, `node scripts/verify-parallel-preview-config.mjs wrangler.worker-parallel-preview.jsonc`, `npm run build`, and `npx wrangler deploy --dry-run --config wrangler.worker-parallel-preview.jsonc`; expect PASS, static proof of Preview bindings, and no top-level data binding/public route in the deploy dry-run.
- [ ] **Step 5: Commit** the three files as `feat: declare isolated parallel Preview resources`.

### Task 3: Access-first Worker shell and Preview preflight

**Files:** Update `docs/infra-migration-phase-11-api-parallel.md` (create with preflight evidence, then append through Task 8). No product code change.

**Interfaces:** Task 2's config and Task 1's wrapper form the inert shell: without `PARALLEL_PREVIEW_TOKEN`, it cannot enter the full API even if invoked internally. The eventual Preview URL is a test endpoint, not `api.vapt.app.br`.

- [ ] **Step 1: Read-only inventory** of Zero Trust availability, Workers/route/Version URL/Preview URL settings, existing Access apps, six namespace IDs, Neon preview identity/ACL, R2 buckets, and current public DNS. Confirm `vapt-api-parallel` is unused or safely reusable; record non-secret before-state in the handoff. If Zero Trust is unavailable, stop here.
- [ ] **Step 2: Deploy** only the route-less, secretless shell with the Task 2 config. Read back its Worker ID and confirm no `workers.dev`, Version URL, custom route, Cron, Queue consumer, or API deployment was enabled; otherwise disable that exposure and stop.
- [ ] **Step 3: Attach** a deny-by-default Access self-hosted application with destination `{type: "preview_worker", worker_id: <this Worker ID>}`, allowing only the owner/test operator and a narrowly scoped automation service token if needed. Read the policy back; reject `worker`, `all_preview_workers`, account-wide, bypass, frontend-worker, or wildcard destinations.
- [ ] **Step 4: Deploy one inert Preview** after Access readback, still without the bearer or app secrets.
- [ ] **Step 5: Prove** an unauthenticated request is blocked by Access, then an Access-authenticated request is blocked by the wrapper before any app/Neon/provider call. If either proof fails, do not install full API secrets. Record status, policy ID, Worker ID, and no-secret evidence.
- [ ] **Step 6: Commit** the handoff preflight as `docs: record parallel Preview Access gate`.

### Task 4: Preview secrets, bindings and full-API smoke

**Files:** Modify `docs/infra-migration-phase-11-api-parallel.md`; change Task 2 config only if verified resource inventory requires it.

**Interfaces:** Use `npx wrangler preview` with `wrangler.worker-parallel-preview.jsonc` only after Task 3 passes. Do not edit `wrangler.worker.jsonc` or bind production Hyperdrive. Secrets are installed into the single named Preview (or its Base only after verifying no other Preview inherits them).

- [ ] **Step 1: Verify RED**: with the Access-approved inert endpoint and no bearer secret, the wrapper returns sanitized `503` without a DB/provider call. Re-run Task 2's static checker before provisioning.
- [ ] **Step 2: Provision** a random Preview bearer first via a write-only Preview secret facility; confirm missing bearer now returns `401`, while valid bearer with incomplete app config returns sanitized `503`. Then create/rotate an R2 S3 signing credential scoped to `vapt-assets-preview` and install the remaining Better Auth, Turnstile-test, Resend-sending-only, Stripe Test and required `environment.ts` values as Preview secrets/variables; never use CLI arguments or Git. Deploy the updated Preview configuration and confirm all six rate-limit bindings, `R2_BUCKET` and preview Hyperdrive are present only there, not in the shell's top-level deployment.
- [ ] **Step 3: Verify GREEN**: Access+bearer `/health` returns `200`; `/health/ready` and one authenticated preview identity query reach real Hyperdrive with database `vapt`/role `vapt_api_preview`; a controlled protected-group test with a missing binding fails closed. Read back only non-secret resource names and environment markers. Keep Coolify/production traffic unchanged.
- [ ] **Step 4: Record** secret names/rotation status, non-secret Preview ID/URL, binding inventory, request status, and any blocker in the handoff. Re-run `npm test`, `npm run test:worker`, `npm run build`, and both Worker dry-runs.
- [ ] **Step 5: Commit** only non-secret config/handoff changes as `docs: record full parallel Preview smoke`.

### Task 5: Versioned read-only API parity matrix

**Files:** Create `scripts/compare-parallel-api.mjs`, `scripts/compare-parallel-api.test.mjs`; modify `docs/infra-migration-phase-11-api-parallel.md`.

**Interfaces:** Export `compareParallelApi({coolifyBaseUrl, previewBaseUrl, previewHeaders, fetcher}: ComparisonInput): Promise<ComparisonResult[]>`. Fixed matrix: `GET /health`, `GET /auth/me` unauthenticated, `GET /restaurants/me` unauthenticated, `GET /public/restaurants/__stage11_missing__/catalog`, and a malformed read-only path. Compare method/path support, status, content type, safe error keys, CORS/credential headers and auth behavior; normalize timestamps/request IDs and environment IDs. Return only sanitized differences, never bodies/cookies/tokens.

- [ ] **Step 1: Write failing tests** with fake transports for matching responses, volatile IDs, real status/error mismatch, failed Access authorization, and a guard rejecting any matrix entry with a mutating method or request body.
- [ ] **Step 2: Run** `node --test scripts/compare-parallel-api.test.mjs`; expect RED.
- [ ] **Step 3: Implement** the fixed matrix and read-only comparator. Do not mirror writes, reuse Coolify session cookies, or call a provider. Require explicit Access and Preview bearer input from process memory without printing it.
- [ ] **Step 4: Run** focused tests, then the bounded remote comparison once against `https://api.vapt.app.br` and the protected Preview URL. Record status/headers/differences in the handoff, including legitimate divergence from separate databases.
- [ ] **Step 5: Commit** script, tests and sanitized matrix as `test: compare Coolify and protected Worker HTTP contracts`.

### Task 6: Isolated Preview synthetic API and R2 flows

**Files:** Create `scripts/verify-parallel-preview-flows.mjs`, `scripts/verify-parallel-preview-flows.test.mjs`; modify `docs/infra-migration-phase-11-api-parallel.md`.

**Interfaces:** Export `runPreviewFlows({baseUrl, accessHeaders, bearer, fetcher, tag, cleanup}: FlowInput): Promise<SanitizedFlowSummary>`, where `cleanup(tag, createdIds)` removes only tagged Preview rows/objects after the run. The `tag` is a random `stage11-...` prefix; the runner is hard-bound to the verified Preview URL and never accepts the Coolify or production API hostname. Because the public API has no delete for restaurant/order, the remote operator supplies a separately verified preview-only Neon cleanup function; never give production credentials to the runner.

- [ ] **Step 1: Write failing tests** with fake transport for signup/verification/login/session/logout, owner restaurant/menu/order CRUD and concurrent order handling, R2 presign → direct `PUT` → metadata/public read → Worker delete, and `cleanup` call on success/error. Assert a modified R2 key, MIME, length, or expired signature fails and leaves zero objects; assert no production hostname, non-test provider, non-approved email recipient, or secret appears in the summary.
- [ ] **Step 2: Run** `node --test scripts/verify-parallel-preview-flows.test.mjs`; expect RED.
- [ ] **Step 3: Implement** the smallest fixture runner around existing route shapes. Send Better Auth mail only to `delivered@resend.dev`; verify session persistence across invocations and revocation. Reuse the preview `r2.dev`/CORS only for this test. Check order idempotency/concurrency and ownership, call the preview-only `cleanup` in `finally`, and verify preview outbox empty.
- [ ] **Step 4: Run** focused tests and remote flow only after Tasks 3–4 gates. Verify Neon role/branch again, R2 signed constraints, zero tagged DB rows/objects and no provider/email other than approved test delivery. If Stripe Test and Access-safe signed delivery are available, add one controlled checkout plus signed Test webhook and idempotency check through Access; otherwise record this as an explicit unproven gate, never create a public webhook bypass.
- [ ] **Step 5: Commit** script/tests and sanitized evidence as `test: prove synthetic parallel Preview flows`.

### Task 7: Production-only least-privilege database role

**Files (parent repository):** Create `infra/neon/007_worker_production_role_grants.sql`, `infra/neon/verify-worker-production-role.sql`; modify `docs/infra-migration-phase-4-neon.md`. Do not modify the Preview grants/verifier.

**Interfaces:** Mirror the exact reviewed table/function allowlist in `006_worker_preview_role_grants.sql` for login role `vapt_api_production`, with the same no-owner/no-membership/no-admin and excluded-object checks as `verify-worker-preview-role.sql`. Apply only to Neon project `dawn-morning-27332079`, branch `br-odd-term-b6j2n9ms`, database `vapt`.

- [ ] **Step 1: Write the new ACL verifier** by specializing the reviewed Preview verifier, then confirm both branch IDs/endpoints and production schema/function inventory plus existing versioned verifiers; verify `vapt_api_production` does not exist and no synthetic production records need copying. Run the new verifier before role creation and observe RED for role absence.
- [ ] **Step 2: Create** `vapt_api_production` as a login without a persisted password or admin attributes, then apply `007` using the direct production endpoint only. The script must guard database/role attributes and grant no `CREATE`, ownership, membership, `TRUNCATE`, `TRIGGER`, excluded table reads, or unlisted function execution.
- [ ] **Step 3: Verify GREEN**: run all production schema verifiers and the new ACL verifier as owner and restricted role. In a rollback-only restricted transaction, prove Better Auth CRUD and one allowed function; prove DDL, unrelated reads, ownership and excluded grants fail with SQLSTATE `42501`. Confirm preview branch lacks `vapt_api_production` and production branch lacks `vapt_api_preview`.
- [ ] **Step 4: Record** branch/role/ACL results without passwords and run `git diff --check`.
- [ ] **Step 5: Commit** only the two SQL files plus parent Neon handoff as `feat: prepare limited production API database role`.

### Task 8: Production Hyperdrive readiness and Stage 11 handoff

**Files:** Modify API `docs/infra-migration-phase-11-api-parallel.md` and parent `docs/infra-migration-phase-4-neon.md`. Do not add the production Hyperdrive ID to any Wrangler config.

**Interfaces:** Create one separately named `vapt-api-neon-production` Hyperdrive against the direct production Neon host, database `vapt`, role `vapt_api_production`, cache disabled, origin limit 5. Production role password is rotated in memory and supplied only to Cloudflare's write-only origin field.

- [ ] **Step 1: Verify RED**: inventory confirms no production Hyperdrive binding, route, Cron or traffic; inspect the direct production Neon endpoint and role. Do not proceed if it is a `-pooler` endpoint or differs from Task 7 branch.
- [ ] **Step 2: Create** the cache-disabled Hyperdrive with the rotated role password; never print/persist complete URI or credential. Read back ID, host, database, role, cache flag and origin limit; assert exact production target and that the ID differs from preview `0c05fec2924b4f3b9225f3d689ba7ea9`.
- [ ] **Step 3: Final verification**: repeat Access denial and bearer denial, Preview binding/Neon identity, parity matrix, tagged DB/R2/outbox zero-residue counts, production ACL verifier and Hyperdrive readback. Run `npm test`, `npm run test:worker`, `npm run build`, both dry-runs, `git diff --check`, and secret scan. Record commands/results, mismatches, non-secret IDs, secret lifecycle, cleanup, rollback, and explicit Stage 12/13 gaps in both handoffs.
- [ ] **Step 4: Commit** only handoff updates. Leave Coolify at `api.vapt.app.br`, production Hyperdrive unbound, Worker shell without public routes/Cron, and Preview protected. If any exposure/credential error occurs, disable Preview URL or revoke only newly created credentials/resources, clean tagged Preview data, and report the blocker; do not alter public traffic.
