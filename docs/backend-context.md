# vapt-api Backend Context

## Purpose

`vapt-api` is the public backend boundary for Vapt.

The architectural rule is:

`frontend -> vapt-api -> internal services`

The frontend must not call n8n directly anymore.

## Current Role of n8n

n8n is still the internal execution engine for:

- Stripe billing flows
- Asaas billing flows
- webhook processing flows
- ingest/automation flows already modeled in the existing project

`vapt-api` is responsible for:

- authentication
- restaurant access checks
- request validation
- rate limiting
- secret isolation
- webhook signature validation
- idempotency persistence
- forwarding normalized/internal requests to n8n

## Current Backend Status

Implemented phases:

- Phase 0: bootstrap, Fastify app, Docker, health routes
- Phase 1: config, logger, error handling, folder structure, strict startup config
- Phase 2: internal n8n client
- Phase 3: local Supabase JWT validation and initial restaurant authorization adapter
- Phase 4 Stripe: public billing routes backed by n8n
- Phase 4 Asaas: public billing routes backed by n8n
- Phase 5: provider webhooks in `vapt-api` with signature validation and persisted idempotency
- Phase 6: request validation with Zod and grouped rate limits

## Current Public API Surface

Health:

- `GET /health`
- `GET /health/ready`

Auth:

- `GET /auth/me`
- `GET /auth/restaurants/:restaurantId/access`

Stripe billing:

- `POST /billing/stripe/checkout`
- `POST /billing/stripe/subscription/change`
- `POST /billing/stripe/subscription/cancel`
- `GET /billing/stripe/subscription`

Asaas billing:

- `POST /billing/asaas/setup`
- `GET /billing/asaas/setup/status`
- `POST /billing/asaas/pix`
- `POST /billing/asaas/pix/public`

Ingest:

- `POST /ingest/order-feedback`
- `POST /ingest/push-subscription`

Webhooks:

- `POST /webhooks/stripe`
- `POST /webhooks/asaas`

## Security Rules

- startup fails if required env is missing or invalid
- CORS is allowlist-based through `CORS_ORIGINS`
- auth tokens are validated locally with Supabase JWT secret
- authorization currently uses the existing `restaurants.owner_id` model behind an adapter
- billing and webhook secrets stay only in backend env
- request validation uses `zod`
- rate limiting is grouped by route class

## Rate Limit Groups

- `auth`: low limit
- `billing`: medium limit
- `webhooks`: high limit
- `health`: effectively unrestricted

The app trusts proxy headers and uses `x-forwarded-for` when available.

## n8n Compatibility Notes

`N8N_BASE_URL` must point to the webhook base, for example:

`https://your-n8n-host/webhook`

The internal n8n client contains explicit contracts for:

- Stripe billing operations
- Asaas billing operations
- ingest operations
- Stripe webhook forward
- Asaas webhook forward

The backend forwards webhook payloads to n8n in raw form to preserve compatibility with the current workflows.

## Webhook Idempotency

The backend reuses existing Supabase tables:

- `billing_provider_events`
- `payment_provider_events`

Gateway-level webhook idempotency is stored with distinct providers:

- `stripe_gateway`
- `asaas_gateway`

This avoids colliding with the idempotency already used inside legacy n8n workflows.

Processing rule:

1. validate provider signature/token
2. persist receipt/idempotency record
3. if duplicate, stop
4. forward to n8n
5. mark processed only after successful forward
6. if forwarding fails, persist failure state for future retry

## Authorization Model

Current implementation:

- one owner user per restaurant, based on `restaurants.owner_id`

Planned future direction:

- membership-based access
- multiple restaurants per account
- multiple roles per restaurant, such as owner, manager, cashier, kitchen

The backend should continue using the authorization adapter, not hardcode `owner_id` assumptions into route logic.

## Environment Summary

Important env vars currently required:

- `CORS_ORIGINS`
- `N8N_BASE_URL`
- `N8N_TIMEOUT_MS`
- `VAPT_APP_ENDPOINT_SECRET`
- `VAPT_WEBHOOK_SETUP_SECRET`
- `VAPT_ADMIN_ENDPOINT_SECRET`
- `STRIPE_WEBHOOK_SIGNING_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`

Useful optional/defaulted env vars:

- `NODE_ENV=production`
- `PORT=3000`
- `HOST=0.0.0.0`
- `LOG_LEVEL=info`
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS=300`

## Recommended Next Work

The highest-value next step is frontend migration:

- replace direct frontend->n8n calls with frontend->`vapt-api`
- update the React app contracts to the backend routes above
- validate real environment flows on EasyPanel

After that:

- replace the temporary authorization lookup with real Supabase-backed access checks
- improve operational observability and request correlation
- later evolve to membership/role-based authorization
