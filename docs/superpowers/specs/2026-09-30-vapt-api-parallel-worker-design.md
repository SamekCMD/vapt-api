# Vapt API Stage 11: protected parallel Worker and production database readiness

Status: written specification approved by the owner in conversation on 2026-09-30; implementation plan awaiting review. This follows the completed Stage 10 preview Hyperdrive handoff. The Vapt migration plan's Stage 11 is parallel operation, not the Stage 13 public API cutover. Coolify remains the serving API at `api.vapt.app.br`. Vercel and Easypanel are legacy and are not migration targets. No customer accounts or production billing events need preservation.

## Intent and success boundary

Run the native full API Worker in a private Cloudflare Preview while Coolify continues serving the public API. Exercise real preview Neon and R2 through controlled synthetic requests, compare representative HTTP contracts with Coolify without mirroring mutations, and record every mismatch. In the same stage, prepare a separate least-privilege Neon `production` role and Hyperdrive configuration, but do not attach them to the reachable Preview, enable production API traffic, or change DNS, Cron, Stripe Live, or Coolify.

Stage 11 is an API-level parallel proof. It does not certify browser cookie behavior between the current `workers.dev` frontend Preview and the API Preview, sustained production load, realtime/WebSockets, provider-originated public webhooks, or the final cutover. Those remain explicit later gates; an HTTP client's ability to send a cookie is not presented as a browser test.

## Decision and alternatives

Use a Cloudflare Worker Preview protected by Cloudflare Access, with an additional Preview-only bearer gate before the full API entrypoint. This gives a stable private comparison target and keeps all application routes inaccessible if an Access policy drifts. The gate must reject missing or wrong credentials before configuration, pool creation, storage, provider, or route dispatch; the production entrypoint and public contract remain unchanged. The Preview runs with `ENVIRONMENT=preview` and explicit preview-only bindings and secrets. Cloudflare Previews do not inherit production variables or account-level resource isolation automatically, so each binding must be declared and checked.

A temporary `wrangler dev --remote` session with only a bearer gate would be simpler but would not provide a stable parallel endpoint or durable observations. Request mirroring/shadow writes from Coolify would risk duplicate orders, payments, emails, or divergent databases and is rejected. No test sends the same mutating request to both systems automatically.

## Protection and deployment order

First inspect the Cloudflare account's Zero Trust/Access capability, existing Workers, Preview settings, and route inventory without changing them. Create or reuse only a route-less Worker shell with `workers_dev` and Version URLs disabled; it must have no public API route or Cron. Attach a deny-by-default Access application to this Worker's Previews and grant only the owner/test operator. Verify the policy and destination before enabling any full-API Preview URL. If this order cannot be established, stop rather than temporarily publishing the route inventory. Do not attach Access account-wide or to the existing frontend Worker.

Deploy a separate Preview-only wrapper around `src/worker/index.ts`. Its random bearer secret is a Cloudflare Preview secret, never a Wrangler `vars` value, Git file, process argument, log, or response. Test both layers: requests without Access authorization must be blocked at the edge, and requests that reach the wrapper without the bearer must be denied without a database/provider call. The bearer is for automated API testing, not for inclusion in frontend code. There is no unauthenticated API hostname or DNS edit in this stage. The Access-protected Preview URL remains a test endpoint; no user traffic is switched to it.

If Access, Preview URL behavior, or secret installation cannot be proven before full-route exposure, retain the route-less Worker and report a blocker. A successful `/health` response alone is not acceptance.

## Preview runtime and resource isolation

Reuse only the existing `vapt` Neon preview branch (`br-rough-dew-b6ydeygb`), database `vapt`, role `vapt_api_preview`, and cache-disabled Hyperdrive `0c05fec2924b4f3b9225f3d689ba7ea9`. Before deployment, recheck the direct origin host, role privileges, production-role absence from preview, and zero synthetic residue. The Preview must never fall back to `DATABASE_URL`, another Hyperdrive, or the Coolify API.

Bind only `vapt-assets-preview` as `R2_BUCKET`. Create or rotate a preview-bucket-scoped S3 signing credential because the earlier smoke's one-time secret was discarded. Put signing credentials in Preview secrets and verify the returned signed `PUT` is limited to the intended object key, MIME, size and short TTL. Use the existing preview `r2.dev` URL and CORS configuration only for the test. Do not bind or write `vapt-assets-production`.

Configure all six native Worker rate-limit bindings with Preview-specific namespace IDs. Missing protected-group bindings remain fail-closed. Install the required Better Auth, Turnstile-test, Resend-sending-only, and Stripe **Test Mode** values as Preview secrets or non-secret Preview variables according to their type; reuse existing restricted test resources when valid. Do not install Stripe Live credentials, a public webhook destination, a Queue consumer, a Cron trigger, or production R2 secrets. Better Auth test mail may go only to the previously approved Resend test recipient; no customer receives mail.

## Production database preparation without traffic

In the existing Neon project, inspect `production` (`br-odd-term-b6j2n9ms`) and confirm the schema/function inventory and versioned verifier results match the reviewed preview baseline. Add a versioned production-role grant script and verifier in the parent repository. Create a new `vapt_api_production` login role with no administrative attributes, ownership, inherited privileged membership, or unintended schema/function access. Prove normal API/Better Auth DML in a rollback-only transaction and prove DDL/unrelated reads fail. Do not copy test users, UUIDs, sessions, billing records, or objects into production.

Create one separately named, cache-disabled Hyperdrive configuration pointing to the **direct** Neon production endpoint and this production-only role. Rotate the role password in memory and supply it only to the write-only Cloudflare origin field; never print or persist the complete URI. Read back non-secret host/database/role/cache/connection-limit metadata and compare it to the production branch endpoint. Keep the resulting ID out of the Preview binding and out of any reachable production Worker configuration for now. This is resource readiness, not proof of production Worker traffic or authorization for Stage 13.

## Parallel comparison and synthetic flows

Use a small, versioned comparison matrix. Against Coolify and the Worker Preview, compare method/path support, status, content type, safe error shape, CORS/credential headers, and authenticated/unauthenticated behavior for representative read-only routes. Normalize timestamps, request IDs, and environment-specific IDs. Record meaningful differences; do not call unequal database contents a parity failure, and do not reuse Coolify session cookies on the Preview branch.

Run stateful flows **only** on the isolated Worker Preview with tagged synthetic records: Better Auth creation/verification/login/session/logout or revocation; owner-scoped restaurant/menu/order CRUD and concurrent order behavior; a real R2 presign, direct `PUT`, metadata/public read and Worker-side delete; and one controlled Stripe Test checkout/signed webhook path if test credentials and Access-safe delivery are available. For webhook testing, the operator may send a valid signed Test request through Access; do not open a public bypass or claim this proves provider-originated delivery. Verify idempotency and cleanup, and leave the preview outbox empty. No Mercado Pago live call, Stripe Live call, customer email, or production write is part of the proof.

The Preview may return controlled failures for unavailable optional providers, but unexpected missing required bindings, wrong branch/role, Access bypass, a leaked secret, a residual synthetic object/row, or a real provider call stops the run. The Coolify service is not redeployed or reconfigured to make a comparison pass.

## Verification, rollback and handoff

Before remote work, keep the API Node tests, `workerd` tests, strict build, Worker dry-run and route inventory green. Add focused tests for the Preview wrapper's fail-closed ingress, exact preview bindings, rate-limit separation, wrong database role, R2 presign/delete, and sanitized errors. Remote acceptance requires evidence of Access denial and bearer denial before app execution; full Worker requests through real preview Hyperdrive; Better Auth across invocations; a bounded set of API parity comparisons; real R2 upload/read/delete with zero leftover objects; preview data cleanup; and verified production-role grants/Hyperdrive metadata with no production Worker traffic.

Keep the public Coolify API untouched as the rollback path. On a Preview failure, disable its URL/Access path or revert the Preview deployment, revoke exposed test secrets if needed, and clean only tagged preview data and objects. If the production Hyperdrive points to the wrong target or the role has excess privilege, disable/revoke only those newly created production resources; never modify existing business schema or public traffic as a rollback shortcut.

The Stage 11 handoff records exact commands/results, non-secret resource IDs, comparison matrix and discrepancies, secret lifecycle, cleanup counts, limitations, and prerequisites for Stage 12 realtime and Stage 13 cutover. No merge, public route, DNS change, Cron, Stripe Live activation, Coolify retirement, or production Worker binding is inferred from this acceptance.

## References

- Migration sequence: parent `docs/infra-migration-plan.md`, Stage 11 and mandatory tests.
- API handoffs: `docs/infra-migration-phase-9-api-worker-native.md` and `docs/infra-migration-phase-10-hyperdrive-neon-preview.md`.
- R2 state: parent `docs/infra-migration-phase-3-r2.md`; Neon topology/grants: parent `docs/infra-migration-phase-4-neon.md` and `infra/neon/006_worker_preview_role_grants.sql`.
- Cloudflare Worker Previews and isolation: https://developers.cloudflare.com/workers/previews/ and https://developers.cloudflare.com/workers/previews/resources/.
- Cloudflare Access for Workers: https://developers.cloudflare.com/workers/configuration/cloudflare-access/.
