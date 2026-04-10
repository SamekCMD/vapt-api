# Vapt API Phase 2 n8n Client Design

Date: 2026-04-10

## Goal

Add an internal n8n client to `vapt-api` so the backend can call the approved workflow contracts through one centralized transport layer.

Phase 2 is not about exposing final billing or ingest routes yet. It is about creating the backend-owned integration boundary that replaces direct frontend-to-n8n transport over time.

## Current State

`vapt-api` already provides:

- strict startup configuration
- structured logging
- global error handling
- restricted CORS
- health endpoints

The product documentation already defines stable n8n contracts for:

- Asaas
- Stripe
- Ingest

Those contracts are currently still part of the system reality and should be encapsulated rather than duplicated ad hoc in future route handlers.

## Scope

Phase 2 includes:

- n8n-specific configuration in backend startup config
- a centralized internal HTTP client for n8n
- an explicit catalog of supported n8n routes
- automatic header selection per route type
- timeout support
- transport and response error normalization
- tests for route catalog behavior, header mapping, timeout, and failure normalization

Phase 2 does not include:

- public business endpoints in `vapt-api`
- authentication or authorization
- Supabase validation
- restaurant access checks
- billing logic in backend code
- webhook processing in backend code
- retries
- payload schema validation for business routes

## Architecture

The n8n integration is organized as a backend module.

### `src/modules/n8n/contracts.ts`

Defines the approved route catalog.

Responsibilities:

- expose named operations instead of loose strings
- define HTTP method
- define path
- define header strategy

The rest of the application should not build n8n URLs by hand.

### `src/modules/n8n/client.ts`

Owns HTTP execution against n8n.

Responsibilities:

- resolve endpoint URL from the catalog
- attach the correct auth header
- apply timeout
- send request body when appropriate
- parse the response
- normalize transport failures
- normalize non-2xx responses

### `src/modules/n8n/errors.ts`

Contains integration-specific error normalization for the n8n transport layer.

Responsibilities:

- convert low-level fetch failures into application-safe integration errors
- distinguish timeout, connection, and invalid-response scenarios
- preserve loggable context without leaking raw details to callers

### `src/modules/n8n/index.ts`

Exports the public entrypoint for the module.

### `src/lib/config.ts`

Extends the startup config to include the required n8n settings.

## Required Configuration

Phase 2 adds these required environment variables:

- `N8N_BASE_URL`
- `N8N_TIMEOUT_MS`
- `VAPT_APP_ENDPOINT_SECRET`
- `VAPT_WEBHOOK_SETUP_SECRET`
- `VAPT_ADMIN_ENDPOINT_SECRET`

Rules:

- `N8N_BASE_URL` must be a valid absolute URL
- `N8N_TIMEOUT_MS` must be a positive integer
- all secrets must be non-empty
- invalid n8n configuration must fail at startup

## Route Catalog

The route catalog must support all approved workflow families already documented.

### Asaas

- `asaas.setup` -> `POST /asaas/setup`
- `asaas.setupStatus` -> `GET /asaas/setup/status`
- `asaas.setupRefresh` -> `POST /asaas/setup/refresh`
- `asaas.pixCreate` -> `POST /asaas/pix/create`

### Stripe

- `stripe.subscriptionCreate` -> `POST /stripe/subscription/create`
- `stripe.subscriptionChange` -> `POST /stripe/subscription/change`
- `stripe.subscriptionCancel` -> `POST /stripe/subscription/cancel`
- `stripe.subscriptionStatus` -> `GET /stripe/subscription/status`
- `stripe.health` -> `GET /stripe/health`

### Ingest

- `ingest.pushSubscription` -> `POST /ingest/push-subscription`
- `ingest.orderFeedback` -> `POST /ingest/order-feedback`

## Header Strategy

The client chooses headers from route metadata instead of requiring callers to know secret names.

Rules:

- app routes use `x-vapt-app-key`
- Asaas setup uses `x-vapt-webhook-key`
- admin routes use `x-vapt-admin-key`

This preserves current workflow expectations while removing secret handling from callers.

## Request Model

The module should expose named operations through a generic internal executor.

Expected behavior:

- `GET` routes do not send a request body
- `POST` routes send JSON when body data exists
- caller supplies only operation name and optional body
- the client returns normalized success payloads with:
  - `status`
  - `data`
  - relevant response headers when needed

The module is transport-focused only. It should not perform business validation or response shaping for product workflows yet.

## Error Model

The module must normalize these failure categories:

- timeout
- connection failure
- upstream non-2xx response
- invalid or unexpected response payload

These should become backend-safe integration errors rather than raw fetch errors.

The normalized error layer should support later global handling and logging without binding the backend to undifferentiated upstream exceptions.

## Test Strategy

Phase 2 should include test-first coverage for:

- config validation for n8n env values
- route catalog lookup
- automatic header selection
- URL construction
- timeout behavior
- non-2xx response normalization
- invalid JSON or invalid content handling

Tests may use local stubs or lightweight in-process HTTP servers. They should avoid relying on a real n8n instance.

## Acceptance Criteria

Phase 2 is complete only when:

- startup fails for missing or invalid n8n config
- all approved n8n routes are represented in the route catalog
- the client selects headers correctly
- timeout is enforced
- transport failures are normalized
- tests cover the important transport behavior
- the project still builds cleanly

## Architectural Decision Captured

The backend becomes the transport owner for n8n now, even before it becomes the full business owner for billing and ingest flows later.
