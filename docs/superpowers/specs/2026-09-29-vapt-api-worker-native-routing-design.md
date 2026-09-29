# Vapt API on Workers: native HTTP routing design

Status: approved direction, design for Stage 9. This supersedes the Fastify HTTP bridge architecture in `docs/infra-migration-phase-9-api-worker-design.md` and the uncompleted Tasks 4–6 of `docs/infra-migration-phase-9-api-worker-plan.md`. The runtime findings remain in `docs/infra-migration-phase-9-runtime-blocker.md`.

## Intent and boundaries

Move the full Vapt API HTTP surface from the current Coolify-hosted Fastify process to a Cloudflare Worker without changing its public contract or business decisions. The owner chose a Worker-native Hono routing layer after the Fastify bridge failed in `workerd`. Keep Coolify serving the API and keep its Docker entrypoint usable until later parallel-run and cutover stages. There are no customer accounts or production billing events to preserve. Vercel and Easypanel are legacy, not migration targets.

Stage 9 produces code and local runtime evidence, not a public deployment. Do not change DNS, Coolify, Stripe Live, real Neon branches, Hyperdrive configurations, or Worker secrets in this stage. Stage 10 connects separate preview/production Hyperdrive bindings to their corresponding Neon branches; Stage 11 runs the two APIs in parallel; Stage 13 changes the public API route. The Worker must never fall back to the production Neon URL, a Coolify proxy, or process-local security controls when a required binding is missing.

Success means the Worker bundle starts and serves the complete route inventory in `workerd`, the security-sensitive HTTP behavior matches the Fastify API, and Node tests/build plus Worker tests/build pass. This is not proof of remote database/provider integration or production readiness.

## Decision and alternatives

Use Hono as the Worker HTTP router, with Fetch `Request`/`Response` at the boundary. Hono officially supports Cloudflare Workers and a module export that combines `fetch` and `scheduled`. Route registration is static and does not initialize Fastify. This eliminates the demonstrated `find-my-way` dynamic-code and Avvio boot path. It does not assume every imported dependency will work in `workerd`; bundle/start/behavior tests are mandatory gates.

A custom Fetch router would remove one dependency but would make us implement and maintain routing, middleware ordering, parameters, and method behavior ourselves. A Worker proxy to Coolify would not remove the VPS dependency and therefore is not a Stage 9 API port. Neither is selected.

## Architecture and ownership

The existing Node `buildApp()` and `src/server.ts` continue to compose the Fastify API. A separate Worker entrypoint exports `fetch` and `scheduled`, registers Hono routes once at module startup, and obtains bindings and invocation context from each event. It must not import `src/app.ts` or any Fastify route/plugin module at runtime. No request-time route registration or global copy of mutable environment values is allowed.

Extract transport-independent composition from `src/app.ts` and the Fastify-coupled payment module into small factories, grouped by domain. These factories provide existing repositories, services, Better Auth runtime, payment providers, and reconciliation; they accept explicit database, provider, logging, and background-work dependencies. Fastify and Hono route modules are thin adapters to the same services and schemas. Where a route contains nontrivial decisions beyond transport mapping, move that decision into a shared handler/use-case function, rather than maintaining two business implementations. Do not refactor unrelated domain logic.

The Worker builds request-scoped context from `env` and `ctx` and resolves only the dependencies needed by the matched route. Stage 9 uses fake database/provider dependencies in `workerd` fixtures. A real `pg`/Kysely/Better Auth pool lifecycle through Hyperdrive is a Stage 10 acceptance item, not an assumption hidden behind successful fake tests. `scheduled` obtains the same domain reconciliation service independently of the HTTP router and runs one bounded pass; it never starts a process interval.

The already committed Worker binding/configuration contract, rate-limit backend, and background-task lifecycle are retained where compatible. The environment adapter may be adjusted to support the new composition, but its preview/live-mode and missing-Hyperdrive fail-closed rules remain. The placeholder Wrangler configs, `build:worker`, and `test:worker` must become real and green before Stage 9 is declared complete.

## Request and response contract

Create an explicit inventory of all current methods, paths, aliases, auth requirements, rate-limit groups, and important status/header behavior. The inventory includes Better Auth's `GET|POST /api/auth/*`, Stripe and Mercado Pago webhook endpoints, and the temporary Mercado Pago webhook alias. Each Worker route has one corresponding Fastify contract. No endpoint is silently omitted or replaced by a Coolify proxy.

Apply middleware in a deliberate order: route matching; allowed-origin CORS/preflight; group-specific rate limiting; authentication/authorization; body parsing and Zod validation; domain operation; response/error mapping. Preserve current JSON error codes/messages, status codes (including 200 vs 201 idempotent order replay), redirects, allowed headers, and credentialed CORS behavior. On a disallowed origin, retain the existing externally observable response unless a separate change is approved. Unknown routes retain the current 404 JSON shape. A missing required Worker binding returns a sanitized unavailable response; it cannot produce a partial success.

Better Auth's existing `AuthRuntime.handler(Request): Promise<Response>` is mounted directly for `/api/auth/*`, with the original method, URL, body, and headers preserved. Its `Set-Cookie` headers must remain distinct, and trusted-origin, secure-cookie, and session behavior must match the Node API. Other protected routes reuse `createSessionResolver` and the same owner-scoped authorization checks; the Worker must not accept a legacy bearer token as a substitute for a session.

Signed webhooks read the original request body once, without JSON reserialization before signature verification. Stripe verifies the exact raw text via the existing SDK/service; Mercado Pago retains its header/query signature inputs, body cross-checks, idempotent event reservation, and retry responses. Provider and persistence calls are fake in local HTTP tests, while the signature path itself remains real. The Worker CORS and rate-limit adapters must not consume or mutate webhook bytes.

The menu-image API must continue returning a presigned S3-compatible `PUT` URL; changing clients to upload through the Worker is outside this stage. An R2 Worker binding alone cannot mint that S3 signature. Keep presigning behind the existing `MenuImageGateway` interface with synthetic credentials in Stage 9 tests; use a bucket binding for Worker-side object deletion. Stage 11's remote preview deployment provisions scoped R2 signing credentials as Worker secrets and verifies a real preview upload and delete. Do not put credentials in Wrangler vars or source control.

The existing per-isolate memory map is not a Worker security boundary. The Worker uses the committed Cloudflare rate-limit bindings for the existing route groups, with distinct namespaces per environment at deployment. Prefer Cloudflare's client-IP signal at the direct Worker ingress over client-supplied `X-Forwarded-For`; missing or malformed identity follows one explicit, tested fail-closed policy. Health remains effectively unrestricted. Binding counters are locality-scoped abuse controls, not exact global quotas.

Auth email tasks use the current Worker lifecycle adapter to attach work to `ctx.waitUntil`; failures are logged without recipient addresses or secrets. Billing email remains on its existing Queue path. No Worker route or scheduled event starts the Fastify reconciliation timer, and a scheduled failure remains visible for retry/alerting rather than being reported as success.

## Verification and migration gates

First prove a minimal Hono Worker in `workerd` with a parameterized route, a synthetic binding, and an imported representative transport-independent service. Then migrate the route inventory in domain slices; each slice includes failing HTTP contract tests before implementation and checks the Node API still behaves the same. The tests compare public behavior, not framework internals. Prioritize health/errors, Better Auth and session/CORS, public orders/idempotency, billing and both signed webhook families, then the remaining business/storage/ingest/payment routes and scheduled reconciliation.

The Worker fixture uses synthetic bindings and fake database/provider/email adapters; no test contacts production Neon, Stripe Live, Mercado Pago, or Resend. Coverage must include route inventory completeness; malformed JSON and validation errors; valid/invalid webhook signatures and duplicate-event/retry behavior; two `Set-Cookie` headers; CORS preflight; idempotency and order-token headers; missing bindings; rate-limit denial; absence of a timer; and one bounded scheduled pass. Test the actual bundled Worker through `workerd`, not only a Wrangler dry-run or a Node invocation of Hono.

Stage 9 acceptance requires `npm test`, strict Node build, `npm run test:worker`, `npm run build:worker`, and a clean diff check, with exact results documented. A failure caused by another incompatible SDK or runtime assumption stops the affected slice for diagnosis; do not claim parity from tests that mock away the failing import. No public route, `workers.dev` endpoint, preview trigger, Cron, or production secret is enabled by this stage's Wrangler configuration.

The later Stage 10 gate must verify the real preview Hyperdrive → Neon connection, connection lifetime, Better Auth persistence, transaction semantics, signed remote ingress, and binding/environment isolation before any production connection is considered. Stage 11 compares Coolify and Worker behavior in parallel. Stage 13 alone authorizes public traffic cutover, with rollback to Coolify until stability is established.

## References

- Vapt migration source of truth: `vaptmesaflow/docs/infra-migration-plan.md`, Stage 9 / original Phase 8.
- Runtime blocker and throwaway spike: `docs/infra-migration-phase-9-runtime-blocker.md`.
- Hono on Cloudflare Workers: https://hono.dev/docs/getting-started/cloudflare-workers
- Cloudflare Fetch handler and invocation context: https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/ and https://developers.cloudflare.com/workers/runtime-apis/context/
- Cloudflare rate-limit binding behavior: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare client IP header behavior: https://developers.cloudflare.com/fundamentals/reference/http-headers/
- Hyperdrive with Neon, for Stage 10: https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/
- R2 presigned upload URLs and Worker bindings: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ and https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
