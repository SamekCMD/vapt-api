# vapt-api Backend Context

## Purpose

`vapt-api` is the public backend boundary for Vapt.

The architectural rule is:

`frontend -> vapt-api -> internal services`

The frontend calls only the public Vapt API; billing and business persistence run directly on Neon.

## Current Runtime Ownership

The API owns authentication, restaurant access checks, request validation, rate limiting,
secret isolation, provider SDK calls, webhook verification, canonical state reconciliation
and Neon persistence. Hosted Stripe Checkout and Customer Portal replace workflow-backed
billing. No API/frontend runtime depends on n8n.

## Current Backend Status

Implemented phases:

- Phase 0: bootstrap, Fastify app, Docker, health routes
- Phase 1: config, logger, error handling, folder structure, strict startup config
- Historical Phase 2: internal workflow client, now removed
- Phase 3: Better Auth cookie sessions and initial restaurant authorization adapter
- Stripe billing: official SDK, hosted Checkout, Customer Portal, local signed webhooks and durable email intents
- Phase 4 Asaas: public billing routes and webhook forwarding retired
- Phase 5: provider webhooks in `vapt-api` with signature validation and persisted idempotency
- Phase 6: request validation with Zod and grouped rate limits
- Payment providers v2: manual payment and hosted Mercado Pago checkout for restaurant orders
- Mercado Pago OAuth: encrypted restaurant credentials with rotation
- Mercado Pago webhook: signed, idempotent payment confirmation without n8n

## Current Public API Surface

Health:

- `GET /health`
- `GET /health/ready`

Auth:

- `GET|POST /api/auth/*` (Better Auth)
- `GET /auth/me`
- `GET /auth/restaurants/:restaurantId/access`

Stripe billing:

- `POST /billing/stripe/checkout`
- `POST /billing/stripe/portal`
- `GET /billing/stripe/subscription`

Ingest:

- `POST /ingest/order-feedback`
- `POST /ingest/push-subscription`

Order payments:

- `POST /orders/:orderId/payments/manual`
- `POST /orders/:orderId/payments/checkout`
- `POST /restaurants/:restaurantId/payments/mercado-pago/connect`
- `GET /restaurants/:restaurantId/payments/mercado-pago/status`
- `POST /restaurants/:restaurantId/payments/mercado-pago/disconnect`
- `GET /payments/mercado-pago/oauth/callback`

Webhooks:

- `POST /webhooks/stripe`
- `POST /webhooks/payments/mercado-pago`
- `POST /payments/mercado-pago/webhook` remains as a temporary compatibility alias

## Security Rules

- startup fails if required env is missing or invalid
- CORS is credentialed and allowlist-based through `CORS_ORIGINS`
- protected routes resolve Better Auth cookie sessions and ignore legacy Supabase bearer JWTs
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

## Stripe Webhook Idempotency

Stripe events use provider `stripe` in Neon `billing_provider_events`.
Lifecycle: received, processing, processed, pending_retry, ignored. Atomic claims
increment an attempt token, preserve retryability and fence stale workers; processed
and ignored are terminal. An unexpired in-flight claim returns retryable 503; only terminal duplicates are acknowledged.

The SDK verifies the exact raw body before persistence. The event transaction locks
the restaurant, retrieves the current canonical Subscription, validates mode, tenant,
Customer and exactly one known recurring Price item, and persists the item period/state.
Only this path changes entitlement; browser returns are not billing evidence.

Reconciliation, the event-audited, business-resource-deduplicated `billing_email_outbox` intent and terminal
event status commit together. Checkout/subscription updates emit no activation email;
initial invoice owns activation, cycle invoice owns renewal, payment failure owns its
intent and subscription deletion owns cancellation. Delivery via Queue/Resend is deferred.

Mercado Pago order payments use the provider v2 flow:

1. validate the Mercado Pago HMAC signature
2. reserve the external event id
3. resolve the restaurant account from the provider account id and environment
4. fetch the authoritative payment from Mercado Pago
5. validate transaction, restaurant, currency and server-owned amount
6. apply the payment state transition atomically
7. enqueue `release_order_to_kitchen` only when the payment becomes paid
8. acknowledge duplicates without repeating provider calls or effects

Failed events remain retryable. Processed events cannot be reopened. Stripe billing
continues disponivel; o receptor legado Asaas foi retirado apos a janela de compatibilidade.

## Retirada do Asaas

Em 27 de agosto de 2026, o inventario de producao confirmou ausencia de transacoes,
webhooks, efeitos e eventos Asaas pendentes. Os seis pedidos com estado financeiro
incompleto eram fixtures de teste, sem clientes ou pagamentos reais, e foram aceitos
como excecao operacional.

Este corte remove apenas `POST /webhooks/asaas` e o contrato de encaminhamento ao n8n.
O provider `asaas_legacy`, eventos, colunas e demais dados historicos permanecem
preservados para auditoria e rollback. A limpeza fisica desses dados exige uma entrega
posterior e independente.

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
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_ENVIRONMENT`
- `STRIPE_PORTAL_CONFIGURATION_ID`
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`
- `PUBLIC_ORDER_TOKEN_SECRET`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`
- `DATABASE_URL`
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
- `RESEND_TEMPLATE_VERIFY_ACCOUNT`
- `RESEND_TEMPLATE_RESET_PASSWORD`
- `EMAIL_FROM`
- `FRONTEND_URL`
- `API_PUBLIC_URL`, only required when Mercado Pago is enabled
- `PAYMENT_TOKEN_ENCRYPTION_KEY`, only required when Mercado Pago is enabled
- `MERCADO_PAGO_CLIENT_ID`
- `MERCADO_PAGO_CLIENT_SECRET`
- `MERCADO_PAGO_REDIRECT_URI`
- `MERCADO_PAGO_WEBHOOK_SECRET`
- `MERCADO_PAGO_ENVIRONMENT`

Useful optional/defaulted env vars:

- `NODE_ENV=production`
- `PORT=3000`
- `HOST=0.0.0.0`
- `LOG_LEVEL=info`
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS=300`
- `PAYMENT_EFFECTS_ADMIN_SECRET`, independent optional maintenance credential (at least 32 characters); absent closes the admin route
- `MERCADO_PAGO_TEST_ACCESS_TOKEN` somente no ambiente `sandbox`; deve receber
  o Access Token de **Credenciais de teste** da aplicacao. Em producao, a API
  rejeita essa variavel e resolve a credencial pelo OAuth de cada restaurante.

## Deployment Gate and Next Work

Preview uses Stripe Test Mode only. Production receives additive schema with no test data.
Live credentials, Prices, Portal configuration and webhook destination wait for the
Cloudflare Worker deployment; this phase does not alter current DNS or hosting.
Next: connect durable billing email intents to Cloudflare Queues/Resend, then Worker
portability/deployment and operational observability. Membership/roles remain future work.
