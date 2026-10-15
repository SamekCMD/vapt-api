# Vapt API Stage 10: preview Hyperdrive → Neon design

Status: approved by owner on 2026-09-29. This design follows the approved Stage 9 native Worker handoff and the Vapt migration plan's Stage 10. It does not authorize production traffic or a DNS cutover.

## Intent and success boundary

Prove that the native API Worker can use a real Cloudflare Hyperdrive binding to access the existing Neon project `vapt`, branch `preview`, database `vapt`, without changing production. The proof must cover the existing `pg`/Kysely/Better Auth composition, short transactions, request and scheduled-event connection lifetime, and strict branch isolation. Synthetic records may be created in preview and must be cleaned up; no customer data or production UUID preservation is required. Coolify continues serving the API throughout this stage.

Stage 10 first provisions and tests **preview only**. A production role or Hyperdrive configuration is not created merely because the preview test passes. Any later production binding is a separate owner-visible gate, with the same code and explicit production branch identity checks. No Worker route, `workers.dev` endpoint, Cron trigger, DNS record, Stripe Live setting, R2 resource, or Coolify configuration is changed here.

## Decision and alternatives

Keep `pg@8.23.0` and the current `Database` interface. `withTransaction` calls `database.connect()` and Better Auth uses Kysely's `PostgresDialect({ pool })`; replacing the driver or implementing a `Client`-to-`Pool` adapter would expand the migration and create a second transaction model. The Worker will create a `pg.Pool` **inside each invocation**, initially limited to one connection, from `env.HYPERDRIVE.connectionString`. It will never retain a pool or connected client in module-global state. The limit and cleanup behavior are hypotheses to verify remotely, not assumptions certified by local `workerd` tests. If real Worker/Kysely/Better Auth behavior fails, stop and revise the design before switching drivers or changing transaction semantics.

Create one Hyperdrive configuration for preview, with query caching disabled. The API includes auth, ownership, orders, payments, and immediate read-after-write paths; Hyperdrive's default cached reads can be stale after writes. Hyperdrive connects to the **direct, non-`-pooler`** endpoint of the Neon `preview` branch; do not stack Neon's PgBouncer on Hyperdrive. Keep the existing self-managed Better Auth, not Neon Managed Auth or the Neon serverless driver. An optional second, cached read binding can be evaluated later if workload evidence justifies it; it is not part of Stage 10.

The alternative of using `pg.Client` per request better matches Cloudflare's minimal example but currently conflicts with Kysely's Pool contract and repository transaction interface. Direct Neon serverless connections would bypass the Hyperdrive requirement. Neither is selected for this proof.

## Preview resources and least privilege

Reuse the existing Neon project `dawn-morning-27332079`, branch `preview` (`br-rough-dew-b6ydeygb`), database `vapt`; do not create another project or branch. Inspect current role/schema grants read-only before changing them. Create a dedicated preview-only API role with only the database/schema/table/sequence/function privileges needed by the Vapt API and Better Auth. It must not own the database or schemas, create or drop schema objects, or access a production endpoint. Apply grants through reviewed, versioned SQL; verify both allowed application operations and rejected administrative operations. Preserve the current migrations and production schema.

Create a preview Hyperdrive configuration targeted at that role's **direct** Neon preview connection, with `--caching-disabled`. Its resource ID may appear in preview-only Wrangler configuration; passwords and connection strings must never enter Git, command output, logs, test fixtures, or a checked-in `localConnectionString`. Prefer an input path that does not place a password in shell history or process arguments. Inspect Hyperdrive's returned host/database metadata without exposing credentials, and verify it matches the Neon preview endpoint before a Worker receives the binding.

The production Worker config must still fail closed without a production binding. No fallback to a local `DATABASE_URL`, the Neon production branch, or Coolify is permitted.

## Runtime and diagnostic flow

Keep production HTTP routes unchanged. Add a separate, fixed-operation diagnostic Worker entrypoint/configuration for the preview proof only. It runs via `wrangler dev --remote`, which uploads a temporary Worker to Cloudflare and uses the real Hyperdrive binding; ordinary local `wrangler dev` uses a direct development connection and cannot prove Hyperdrive pooling. This temporary endpoint has no permanent route or Cron trigger and requires a random test secret, supplied outside Git, on every diagnostic request. It must not accept arbitrary SQL, email addresses, provider credentials, or a caller-supplied database URL. Return only pass/fail and non-sensitive database identity fields. Stop the remote session after tests.

The diagnostic exercises the same request-scoped pool factory used by the production Worker, rather than constructing a parallel database client in the test. It checks `current_database()` and `current_user`, a simple query, a parameterized query, and a transaction with a synthetic preview row that is rolled back and then observed absent. It also exercises a commit/read-after-write path followed by cleanup. Tests repeat fresh invocations and limited concurrency to detect stale cross-request sockets, leaked clients, hanging pool timers, or connection exhaustion. A scheduled-event equivalent runs one bounded reconciliation pass against preview and confirms no process timer; it must not contact payment providers.

Better Auth persistence is tested across **separate Worker invocations** against preview's real `better_auth` schema: create or seed a synthetic identity/session through an approved test-only path, resolve it through the existing `AuthRuntime`, and verify expiry/revocation or absence after cleanup. Test-only email delivery is injected or suppressed; the diagnostic must not send to a real recipient or change production auth. Any Turnstile or verification dependency used by this path is explicitly synthetic. Do not weaken the production handler to make the probe pass.

An additional remote smoke of the full production Worker entrypoint is permitted only if the temporary development URL can be access-restricted before requests are sent. It uses preview bindings for safe health/readiness and an authenticated read, verifies sanitized errors, and performs no provider calls or public writes. If the URL cannot be restricted, skip this optional smoke and record that limit; Stage 11 owns the full API parallel run. Never open the full route inventory merely to satisfy a Stage 10 test.

## Verification and stop conditions

Before remote work, keep all local Stage 9 gates green: Node tests/build, `workerd` tests, Worker bundle dry-run, route inventory, and clean diff. Add tests for pool factory configuration, no global reuse, fail-closed missing Hyperdrive, cache-disabled preview config, and diagnostic access control. Record the red assertion before implementation and run focused plus cumulative checks.

Remote acceptance requires evidence of:

1. Neon project/branch/database/role identity, and preview-only grants; no production role/config mutation.
2. A real Cloudflare Hyperdrive connection from remote Worker execution, not a local direct-DB substitute; cache disabled.
3. Successful parameterized query, rollback, commit/read-after-write, and cleanup through existing `Database`/transaction code.
4. Better Auth session persistence across invocations through the real preview schema, without real outbound email.
5. Repeated and concurrent invocations without stale-handle errors, leaked request clients, hanging events, or unbounded origin connections; one bounded scheduled pass.
6. No secret, connection string, recipient, or synthetic account password in Git, logs, test output, or handoff; no public API route, Cron, DNS, Stripe Live, R2, or Coolify change.

If the runtime cannot meet a gate, stop with a precise blocker and preserve the serving Coolify API. A Wrangler dry-run, local direct Neon test, synthetic binding, or successful `/health` response alone is not acceptance. Stage 11 may begin only after this preview database gate is evidenced and the owner has reviewed the handoff.

## Rollback and handoff

Stop the temporary remote-development session, remove any temporary probe access secret, and clean preview-only synthetic records. Keep the preview Hyperdrive configuration and role for Stage 11 only if their target and least-privilege checks pass; otherwise disable/revoke them without touching production. Document resource IDs (not credentials), exact commands and results, schema/grant migration, observed connection behavior, cleanup, known risks, and next-stage prerequisites. Coolify remains the rollback path because it was never switched away.

## References

- Vapt migration source of truth: `vaptmesaflow/docs/infra-migration-plan.md`, Stage 10 / Hyperdrive → Neon.
- Existing Neon topology: `vaptmesaflow/docs/infra-migration-phase-4-neon.md`.
- Stage 9 handoff: `docs/infra-migration-phase-9-api-worker-native.md`.
- Cloudflare Hyperdrive/Neon: https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/
- Hyperdrive lifecycle: https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
- Hyperdrive query caching: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- Hyperdrive local vs remote development: https://developers.cloudflare.com/hyperdrive/configuration/local-development/
- Neon Hyperdrive guidance: https://neon.com/blog/hyperdrive-neon-faq
