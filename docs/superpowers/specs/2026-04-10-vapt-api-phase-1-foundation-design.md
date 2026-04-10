# Vapt API Phase 1 Foundation Design

Date: 2026-04-10

## Goal

Add the first real backend foundation layer to `vapt-api` without introducing domain logic or external integrations.

Phase 1 exists to make the service safe to evolve. It should centralize configuration, enforce strict startup rules, introduce structured logging, standardize error handling, and establish a project structure that supports later phases.

## Current State

`vapt-api` currently provides:

- Fastify bootstrap
- `GET /health`
- `GET /health/ready`
- Docker packaging
- minimal local tests

This is enough to deploy, but not enough to safely grow into the platform boundary for frontend, n8n, Supabase, Stripe, and Asaas.

## Scope

Phase 1 includes:

- centralized environment configuration
- startup failure on invalid or missing required environment variables
- structured logging with Pino
- global error handling
- configurable and restricted CORS
- folder organization for `modules`, `plugins`, and `lib`
- richer health endpoints without external dependency checks

Phase 1 does not include:

- n8n client
- Supabase integration
- authentication or authorization
- billing logic
- webhook processing
- payload validation for business routes
- retries
- rate limiting
- Redis

## Architecture

The backend remains intentionally small and layered by responsibility.

### `src/lib`

Shared low-level utilities and backend primitives.

Planned files:

- `src/lib/config.ts`
  - validates environment variables on startup
  - exports a typed config object used by the app
- `src/lib/errors.ts`
  - defines a minimal application error type with `statusCode` and `code`

### `src/plugins`

Fastify plugins that configure cross-cutting runtime behavior.

Planned files:

- `src/plugins/cors.ts`
  - registers CORS using a strict allowlist from configuration
- `src/plugins/error-handler.ts`
  - registers the global error handler and not-found handler
- `src/plugins/logger.ts`
  - provides the Fastify logger configuration using Pino

### `src/modules`

Route modules grouped by responsibility.

Planned files:

- `src/modules/health/routes.ts`
  - owns `GET /health`
  - owns `GET /health/ready`

### App Composition

- `src/app.ts`
  - creates the Fastify instance
  - loads config
  - wires logger, error handling, CORS, and routes
- `src/server.ts`
  - reads config-derived host/port and starts the server only

## Configuration Rules

Phase 1 adopts strict startup validation.

The service must fail to start when required environment variables are missing or invalid.

Required environment variables for this phase:

- `NODE_ENV`
- `PORT`
- `HOST`
- `CORS_ORIGINS`
- `LOG_LEVEL`

Rules:

- `PORT` must be a valid integer port
- `HOST` must be a non-empty string
- `CORS_ORIGINS` must parse into at least one allowed origin
- `LOG_LEVEL` must be one of the supported Pino levels
- invalid configuration must fail during startup, not on first request

`CORS_ORIGINS` should be a comma-separated list.

## CORS Model

CORS starts restricted, not permissive.

Behavior:

- requests with an `Origin` header are allowed only if the origin is present in `CORS_ORIGINS`
- requests without an `Origin` header remain allowed so that health checks, curl, internal probes, and container checks do not break
- disallowed origins must fail consistently

This keeps the service safe by default while preserving operational traffic that is not browser-originated.

## Logging Model

Logging becomes structured in Phase 1.

Requirements:

- use Pino through Fastify
- use `LOG_LEVEL` from configuration
- keep development logs readable
- keep production logs structured for ingestion
- log unexpected errors centrally through the global error handler

The logger is infrastructural only in this phase. It should not introduce request-specific business fields yet.

## Error Model

All unhandled errors should pass through one global error handler.

Response shape:

```json
{
  "error": {
    "code": "internal_error",
    "message": "Internal server error"
  }
}
```

Rules:

- known application errors return their own `statusCode`, `code`, and safe message
- unknown errors return `500` with a generic error body
- not-found responses should be standardized too
- internal details should be logged, not leaked in responses

## Health Endpoints

Phase 1 keeps health endpoints simple and local.

### `GET /health`

Purpose:

- confirm the process is alive

Expected response:

```json
{
  "status": "ok"
}
```

### `GET /health/ready`

Purpose:

- confirm the service booted with valid configuration and is ready to accept traffic

Expected response:

```json
{
  "status": "ready"
}
```

Phase 1 does not check external readiness such as Supabase, n8n, Stripe, or Asaas. Those checks belong to later phases once those dependencies actually exist in the backend.

## Test Strategy

Phase 1 should be implemented with test-first coverage for the behaviors introduced here.

The important tests are:

- config validation fails on missing required env
- config validation fails on invalid values
- allowed CORS origin succeeds
- blocked CORS origin is rejected
- not-found responses are standardized
- known application errors are normalized
- unknown errors are normalized
- health routes remain stable

## Acceptance Criteria

Phase 1 is complete only when:

- startup fails for missing or invalid required env values
- CORS is enforced from an allowlist
- logs are structured
- errors are standardized
- the folder structure is in place
- the app still builds cleanly
- the app still starts correctly in Docker-oriented runtime conditions

## Architectural Decision Captured

Security posture in this backend starts early:

- configuration is strict now
- CORS is restricted now
- later security controls will build on top of this foundation rather than retrofitting it
