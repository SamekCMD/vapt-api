# Stage 9 Worker runtime compatibility gate

Status: blocked at Task 4 of `infra-migration-phase-9-api-worker-plan.md`. Tasks 1–3 are committed and tested. No Worker was deployed, no Hyperdrive or secret was created, and Coolify remains the serving API.

## What was verified

- The Node API continued to compile and its 410 tests passed after the configuration, rate-limit and lifecycle boundaries were added.
- Wrangler 4.138.0 bundles the API, but a dry-run alone does not prove that the bundle starts in `workerd`.
- The bundled `fastify-raw-body` import using `createRequire(import.meta.url)` failed at module startup because `import.meta.url` was undefined in the bundle. A static import removed that specific failure in a local spike.
- Wrangler selected Pino's browser entrypoint for Fastify; Fastify needs `pino.symbols`, which that entrypoint lacks. Aliasing Pino to its Node entrypoint removed that specific failure in the spike.
- A minimal Worker containing only Fastify, one `GET /health` route, and `httpServerHandler` failed before serving a request with `EvalError: Code generation from strings disallowed for this context`. The stack points to `find-my-way/lib/node.js` calling `new Function()` while registering the route. The full API also stalled during Fastify's plugin boot in `workerd`. These are runtime failures, not missing secrets or a test-runner spawn error.
- The diagnostic Worker and unverified Task 4 application changes were removed. The compatibility date was set to `2026-09-28`, the newest supported by the installed `workerd` binary.

## Decision gate

The approved design explicitly says to stop and revise it if the Fastify bridge cannot run in `workerd`; it does not authorize silently replacing the API route framework. There is no evidence yet that the current lazy Fastify composition can satisfy Workers' dynamic-code restrictions. Cloudflare documents `allow_eval_during_startup`, but startup-only evaluation is a different lifecycle from the approved per-isolate lazy initialization and has not been proved with this API or its bindings.

Before Task 4 resumes, choose and approve a revised design. The least disruptive research path is a bounded spike testing eager app initialization during Worker startup with `allow_eval_during_startup` and a minimal real route. If that fails, the remaining options include a Worker-native route layer or retaining Fastify on Coolify longer. Any route-layer rewrite needs a new parity and migration plan, especially for Better Auth and signed payment webhooks.

## Current branch limitation

`wrangler.worker.jsonc` and `wrangler.worker-test.jsonc` are configuration placeholders for Task 4. Their entrypoint files do not exist yet, so `npm run build:worker` and `npm run test:worker` are not green. Do not merge or deploy this Stage 9 branch as a completed Worker port.
