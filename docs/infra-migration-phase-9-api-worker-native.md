# Stage 9 handoff: native API Worker

Status (2026-09-29): local implementation and verification only. The Hono Worker has not been deployed or exposed. Coolify remains the serving API. The earlier Fastify-in-Worker blocker in `infra-migration-phase-9-runtime-blocker.md` describes a superseded architecture, not the status of this native route implementation.

## Implemented boundary

- `src/worker/index.ts` exports native `fetch` and `scheduled` handlers. The HTTP layer registers 44 method/path contracts, including both Better Auth methods and the Mercado Pago webhook alias. The all-enabled `workerd` inventory test compares the contract with registered Hono routes exactly; disabled Mercado Pago and R2 requests return 404.
- Routes reuse the existing domain services, repositories, validation schemas, ownership checks, Better Auth runtime, Stripe signature verification, Mercado Pago HMAC verification, and payment-effect reconciliation. The Node/Fastify entrypoint, Docker path, and existing tests remain available.
- The scheduled handler performs one bounded reconciliation pass per event, with no process interval. A failed pass rejects so the failure is visible for retry; no Cron trigger is configured yet.
- Production Worker imports contain no Fastify runtime or Coolify proxy. Missing required bindings fail closed with a sanitized 503. The Worker config has `workers_dev: false`, `preview_urls: false`, and no public routes or triggers. The committed Wrangler test configurations contain only synthetic values.
- A synthetic `workerd` test also boots the production entrypoint with valid preview configuration, serves `/health`, and observes denial from a native Cloudflare rate-limit binding. The HTTP adapter validates the ingress IP and enforces the Fastify 1 MiB body limit, including signed webhooks.
- CI now runs the Node tests, the `workerd` suite, TypeScript build, and Worker bundle dry-run. This is a CI configuration change; no remote CI result is claimed here.

## Local verification

Run from this API checkout:

| Command | Result |
| --- | --- |
| `npm test` | 417 passed, 0 failed |
| `npm run test:worker` | 14 passed, 0 failed in `workerd` |
| `npm run build` | exit 0 |
| `npm run build:worker` | exit 0; Wrangler dry-run only |
| `git diff --check` | exit 0 |

These checks prove local route registration and synthetic-runtime behavior, not connectivity to production services or readiness for a public cutover.

## Remaining gates

1. **Stage 10 — database/runtime:** provision isolated preview Hyperdrive → Neon connectivity and prove real Better Auth persistence, transaction behavior, prepared statements/driver compatibility, and Worker connection/pool lifetime. Verify production isolation and the required rate-limit bindings before exposing the Worker. No `DATABASE_URL` fallback is permitted in Worker production.
2. **Stage 11 — storage/parallel operation:** provision preview R2 bucket binding and signing secrets, exercise real preview upload/presign/delete, and compare Coolify and Worker API behavior in parallel. Synthetic storage tests here are not a substitute.
3. **Later cutover:** separately authorize production resources, public Worker route/Cron configuration, DNS cutover, and Coolify retirement under the migration plan. None of those actions occurred in Stage 9.

No real Neon/Hyperdrive/R2 resource, payment-provider request, secret installation, deployment, public route, Cron trigger, DNS change, or Coolify change was made for this Stage 9 implementation.
