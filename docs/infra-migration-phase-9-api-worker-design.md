# Vapt API Worker Runtime — Design

**Superseded (2026-09-29):** The Fastify HTTP bridge failed in `workerd`. The approved replacement design is `docs/superpowers/specs/2026-09-29-vapt-api-worker-native-routing-design.md`. This document remains as decision history, not implementation guidance.

## Intent and success

Port the existing Vapt API from its current Coolify/Docker runtime to a Cloudflare Workers-compatible artifact without changing public API behavior. This is Stage 9 of `vaptmesaflow/docs/infra-migration-plan.md`: preserve the current Fastify routes, services, validation, Better Auth, Stripe, Mercado Pago and Neon persistence boundaries. Coolify remains the serving runtime and rollback path. Success in this stage means the Worker bundle builds and its critical HTTP behavior passes tests in `workerd`; it does **not** mean a public Worker is deployed or `api.vapt.app.br` is changed.

Assumptions confirmed with the project owner: there are no customer accounts or production billing events to migrate, Vercel and Easypanel are legacy, and the current API is on Coolify. Preview must be isolated from production. Do not change DNS, Stripe Live, the Coolify deployment, or the existing Docker entrypoint during this stage.

## Chosen approach

Keep Fastify as the route and plugin layer, and add a Worker entrypoint around it. Cloudflare's Node HTTP server bridge is the first compatibility path; prove it with `workerd` tests before broad changes. Rewriting all routes in Hono or another framework would duplicate the API surface and increase the risk of auth, webhook and payment drift. A Worker that only proxies to Coolify is not a runtime port.

The HTTP bridge is a hypothesis to test, not a claim of blanket Node compatibility. A failure in Fastify, `fastify-raw-body`, Better Auth, Stripe, Mercado Pago or another imported package at bundle or `workerd` runtime is a gate: make a targeted compatibility change with regression coverage, or revise this design before continuing. Do not silently substitute a new route framework.

## Scope boundaries

**In this stage:** Worker `fetch` and `scheduled` entrypoints; explicit environment/configuration boundary; Fastify lifecycle integration; request/response parity; request-scoped background work; an alternative to the in-process payment-effect timer; Worker-safe rate limiting; local `workerd` tests and Wrangler dry-run. The existing Node `src/server.ts` and Dockerfile continue to work.

**Later stages:** create and bind separate preview/production Hyperdrive instances and a dedicated Neon role; connect the real database and run remote preview smoke; run Coolify and Worker in parallel; migrate realtime to Durable Objects; change the API domain; activate Stripe Live; retire Docker/Coolify/Hetzner. This stage must not create Cloudflare resources or install production secrets. A missing required binding fails closed rather than silently connecting to the production Neon URL.

## Runtime and configuration

The Worker exports a Fetch handler and a Scheduled handler. The Fetch handler initializes the existing Fastify app once per isolate, awaits readiness, and hands requests to the Node HTTP bridge. Initialization is promise-cached so concurrent first requests do not create duplicate apps; a failed initialization is surfaced as a sanitized unavailable response and may be retried on a subsequent invocation. There is no public route or trigger in the Stage 9 Wrangler configuration. The Node entrypoint keeps its current startup/configuration behavior.

Worker configuration is constructed from typed Worker bindings, not by assuming that `process.env.NODE_ENV` is a runtime value. Secrets are never logged or committed. The Worker adapter requires an explicit database provider; Stage 9 tests supply a fake provider. The production adapter requires a Hyperdrive binding but cannot use one until Stage 10 creates it. No direct production Neon connection is a fallback. The existing `pg`/Kysely contracts stay in place; Stage 10 resolves connection lifetime and pooling against the actual Hyperdrive binding.

The Worker-specific composition injects lifecycle dependencies into `buildApp` instead of making domain routes aware of Cloudflare. It must not start a process-global payment-effect interval, use `process.pid` as a unique worker identity, or leave Better Auth's email promise detached from the invocation. The Scheduled handler runs one bounded reconciliation pass through the existing database-leased processor when its future Cron trigger is enabled. In this stage the handler is tested locally but no Cron is deployed. Better Auth background work uses the Worker's request lifecycle (`waitUntil`) with failure logging that excludes recipient and secret values; Node retains its existing runner.

The current in-memory rate-limit map cannot be treated as a shared security control across isolates. For Worker requests, the existing route groups and limits are enforced through explicit Cloudflare rate-limit bindings, with separate preview/production namespaces at deployment. Health remains effectively unrestricted. The Worker fails closed for protected groups if the required binding is missing; Node keeps the existing plugin behavior. Cloudflare's counters are per location and eventually consistent, so they are an abuse guard, not exact global accounting. The later domain-cutover review must decide whether additional edge rules are necessary.

## HTTP and security parity

The adapter forwards method, path/query, status, headers, and body without rebuilding JSON before signature verification. Stripe and Mercado Pago webhook tests must prove byte-exact raw-body handling, invalid-signature rejection, duplicate-event behavior and safe retry responses. Auth tests must prove `Set-Cookie` multiplicity, secure-cookie flags, trusted origins and credentialed CORS. Public order idempotency and token headers must survive the bridge. The existing owner-scoped authorization and error shapes remain unchanged.

No Worker test sends a real email, creates a Stripe Live event or mutates production Neon. Provider calls and persistence are faked where the test is about HTTP compatibility; existing API tests continue to cover domain behavior. A later Hyperdrive stage must add preview database integration and signed remote ingress tests before external traffic is routed to the Worker.

## Verification and handoff

Acceptance requires the existing Node API suite and strict TypeScript build to pass; Wrangler dry-run to bundle the Worker; and `workerd` integration tests for health, route forwarding, raw signed webhook payloads, auth cookies/CORS, missing-binding fail-closed behavior, one scheduled reconciliation pass, no in-process timer, and background email lifetime. Test commands must run with synthetic configuration and no live provider secrets. Document incompatibilities and any narrowed coverage rather than presenting a successful bundle as runtime proof.

The Stage 9 handoff records changed files, exact tests, bundle result, Worker runtime limitations and Stage 10 prerequisites. It does not claim public deployment. The existing Coolify API continues serving traffic throughout this stage.

## References

- Vapt migration plan: `vaptmesaflow/docs/infra-migration-plan.md`, Stage 9 / original Phase 8.
- Cloudflare Node HTTP bridge: https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- Cloudflare Worker background lifetime: https://developers.cloudflare.com/workers/runtime-apis/context/
- Cloudflare Worker environment variables: https://developers.cloudflare.com/workers/configuration/environment-variables/
- Cloudflare rate-limit bindings and locality: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Hyperdrive with Neon, for Stage 10: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/
