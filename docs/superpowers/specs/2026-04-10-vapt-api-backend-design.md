# Vapt API Backend Design

Date: 2026-04-10

## Goal

Create `vapt-api` as the secure backend boundary for the Vapt platform, starting with a minimal deployable Node service and evolving it in phases without forcing premature complexity.

## Current Context

- The frontend app currently integrates with n8n through app-side environment variables and route-specific secrets.
- The documented n8n contracts already cover Stripe, Asaas, Pix, and ingest flows.
- Billing and webhook behavior still depend on n8n and need backend centralization.
- The `vapt-api` repository is effectively empty and can be bootstrapped cleanly.

## Core Architecture Decision

The frontend must not call n8n directly anymore for new or migrated sensitive flows.

The canonical request path becomes:

`frontend -> vapt-api -> internal services`

Where internal services may include:

- n8n for existing workflow automation
- Supabase for data and auth validation
- Stripe for subscriptions and billing
- Asaas for Pix and local payment operations

This means `vapt-api` becomes the only public application boundary for sensitive operations. n8n remains an internal automation tool, not the primary backend surface.

## Why This Boundary Exists

- Secrets move out of the frontend.
- Authentication and authorization happen before external calls.
- Billing and automation flows gain a stable orchestration layer.
- Logs, retries, idempotency, and error normalization can be centralized.
- n8n workflows can later be replaced or refactored without breaking the frontend contract.

## Transition Strategy

The first backend versions do not need to replace n8n immediately.

The staged transition is:

1. Introduce `vapt-api` as a minimal deployable backend.
2. Route future sensitive frontend calls through `vapt-api`.
3. Let `vapt-api` encapsulate existing n8n workflows where needed.
4. Gradually migrate critical business logic from n8n into backend code when the code path is stable and justified.

## Phase Model

### Phase 0

Bootstrap a minimal TypeScript + Fastify + Docker service with health endpoints and EasyPanel-ready deployment.

### Phase 1

Add backend foundations only:

- centralized env config
- structured logging
- global error handling
- initial folder organization
- configurable CORS

### Phase 2

Add an internal n8n client so backend-owned flows can call the existing workflow contracts safely.

### Phase 3

Add authentication and authorization using Supabase token validation and restaurant access checks.

### Phase 4

Move billing entrypoints into backend-owned routes while still allowing backend-to-n8n orchestration where appropriate.

### Phase 5

Receive and process provider webhooks in the backend with signature validation and idempotent persistence.

### Phase 6

Harden the service for production with validation, rate limiting, retry policy, and operational safeguards.

## Phase 0 Design

Phase 0 must stay intentionally small.

Required output:

- Fastify server
- `GET /health`
- `GET /health/ready`
- env-based `PORT` with default `3000`
- listen on `0.0.0.0`
- `dev`, `build`, and `start` scripts
- Dockerfile for compiled runtime
- documentation for local run and EasyPanel deploy

Not allowed in Phase 0:

- auth
- Supabase integration
- n8n client
- Stripe logic
- Asaas logic
- webhooks
- business rules
- heavy infra extras

## Success Criteria

Phase 0 is considered complete only if:

- dependencies install cleanly
- the TypeScript build succeeds
- health routes respond locally
- the Docker image builds
- the service is shaped for EasyPanel deployment without extra rework

## Documentation Rule

Important architectural and operational decisions for this project must be persisted in repository documentation rather than left only in chat context.
