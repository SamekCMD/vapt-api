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

Before Task 4 resumes, choose and approve a revised design. The bounded startup-initialization spike described below did not establish a working Fastify Worker. The remaining options include a Worker-native route layer or retaining Fastify on Coolify longer. Any route-layer rewrite needs a new parity and migration plan, especially for Better Auth and signed payment webhooks.

## Authorized startup spike (2026-09-29)

The same Wrangler 4.138.0 and `workerd` runtime were used with a throwaway Worker containing Fastify, a static health route, a parameterized order route, a synthetic variable, and the documented `allow_eval_during_startup` flag. There was no deploy, live binding, database, provider call, or change to the serving API.

| Initialization strategy | Observed result |
| --- | --- |
| Create Fastify and register routes inside `fetch` | `EvalError: Code generation from strings disallowed for this context` at `find-my-way/lib/node.js:220` (`new Function`). |
| Register routes globally and `await app.ready()` at module startup | Worker failed to start: `Top-level await in module is unsettled`. |
| Register routes globally and call `await app.ready()` inside `fetch` | Minimal Fastify boot timed out on Avvio's `bound _after` plugin callback before a response. |

The startup flag addresses the route-code-generation phase but does not, by itself, establish a usable HTTP runtime for this Fastify version. These observations do not prove every possible Fastify adaptation impossible; they rule out the straightforward eager-initialization variant tested here. The throwaway Worker, test, and Wrangler config were removed after the spike. Do not resume Tasks 4–6 against the current design without a new approved architecture and fresh `workerd` parity tests.

## Current branch limitation

`wrangler.worker.jsonc` and `wrangler.worker-test.jsonc` are configuration placeholders for Task 4. Their entrypoint files do not exist yet, so `npm run build:worker` and `npm run test:worker` are not green. Do not merge or deploy this Stage 9 branch as a completed Worker port.
