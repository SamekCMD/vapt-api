# vapt-api

Backend service for Vapt.

## Requirements

- Node.js 24 or newer
- npm
- Docker

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`.

Required variables:

- `CORS_ORIGINS`
- `NODE_ENV` defaults to `production`
- `PORT` defaults to `3000`
- `HOST` defaults to `0.0.0.0`
- `LOG_LEVEL` defaults to `info`
- `N8N_BASE_URL`
- `N8N_TIMEOUT_MS`
- `VAPT_APP_ENDPOINT_SECRET`
- `VAPT_ADMIN_ENDPOINT_SECRET`
- `STRIPE_WEBHOOK_SIGNING_SECRET`
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS` defaults to `300`
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_BUSINESS`, the trusted server-side price catalog; price IDs must never come from the browser
- `PUBLIC_ORDER_TOKEN_SECRET`, a dedicated HMAC secret for public order tokens; do not reuse an authentication secret
- `BETTER_AUTH_SECRET`, at least 32 characters and unique per environment
- `BETTER_AUTH_URL`, the absolute public API origin
- `BETTER_AUTH_TRUSTED_ORIGINS`, a comma-separated exact frontend-origin allowlist
- `DATABASE_URL`, the direct PostgreSQL connection shared by Better Auth and all application repositories
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
- `RESEND_TEMPLATE_VERIFY_ACCOUNT`
- `RESEND_TEMPLATE_RESET_PASSWORD`
- `EMAIL_FROM`
- `FRONTEND_URL`
- `API_PUBLIC_URL`
- `PAYMENT_TOKEN_ENCRYPTION_KEY`

Legacy `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are accepted only by the one-time
`storage:migrate` script; they are not runtime API configuration.

Menu image storage routes are enabled only when the complete R2 configuration is present:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME` (`vapt-assets-preview` or `vapt-assets-production`, according to the environment)
- `R2_PUBLIC_BASE_URL`, the stable public asset origin
- `R2_UPLOAD_URL_TTL_SECONDS`, optional from 60 to 900 seconds (defaults to 300)

R2 credentials stay on the API. The browser receives only a short-lived upload URL for one
menu-item key; deletes are performed by the API after restaurant ownership is checked.

To inventory the current `menu-images` bucket against R2 without writing objects:

```bash
npm run storage:migrate -- --report=r2-dry-run.json
```

The copy mode additionally requires `--apply` and
`R2_MIGRATION_CONFIRM_BUCKET` equal to `R2_BUCKET_NAME`. It never deletes source or target
objects. Keep generated reports outside Git because they contain production object keys.

Mercado Pago order payments are enabled only when the complete configuration is present:

- `MERCADO_PAGO_CLIENT_ID`
- `MERCADO_PAGO_CLIENT_SECRET`
- `MERCADO_PAGO_REDIRECT_URI`
- `MERCADO_PAGO_WEBHOOK_SECRET`
- `MERCADO_PAGO_ENVIRONMENT`, which defaults to `sandbox`
- `MERCADO_PAGO_TEST_ACCESS_TOKEN` is optional and sandbox-only. Set it to the
  Access Token shown under the application's **Test credentials**. Production
  rejects this variable and continues to use each restaurant's OAuth token.

The server fails at startup if any required sensitive value is missing or invalid.

3. Start the API:

```bash
npm run dev
```

The service listens on `0.0.0.0` and uses `PORT`, defaulting to `3000`.

`CORS_ORIGINS` must contain a comma-separated allowlist of approved browser origins.
Every origin must be explicit. Add the stable named Cloudflare preview URL when preview
needs to call this API; wildcards are not accepted. Browser authentication uses secure
Better Auth session cookies with credentialed CORS. Authentication endpoints are mounted
under `/api/auth/*`; protected API routes no longer accept Supabase bearer JWTs.

`N8N_BASE_URL` should point at the n8n webhook base, for example `https://your-n8n-host/webhook`.

## Build and run

```bash
npm run build
npm start
```

## Test

```bash
npm test
```

## Docker

```bash
docker build -t vapt-api .
docker run --rm -p 3000:3000 --env-file .env vapt-api
```

## Coolify deploy

- Create a service from this repository.
- Configure build using the included `Dockerfile`.
- Set `CORS_ORIGINS` to your allowed frontend origins.
- Set `API_PUBLIC_URL` to the externally reachable API origin.
- Set `STRIPE_WEBHOOK_SIGNING_SECRET` before enabling the Stripe webhook route.
- Set `MERCADO_PAGO_WEBHOOK_SECRET` to the secret generated for the Mercado Pago Payments webhook.
- For sandbox validation, set `MERCADO_PAGO_TEST_ACCESS_TOKEN` to the application's test Access Token. Never expose it in the frontend or configure it when `MERCADO_PAGO_ENVIRONMENT=production`.
- Optionally override `PORT`, `HOST`, `NODE_ENV`, and `LOG_LEVEL` if you need custom infrastructure behavior.
- Expose container port `3000`.
- After deploy, verify:
  - `GET /health`
  - `GET /health/ready`
  - `POST /webhooks/stripe`
  - `POST /webhooks/asaas`
  - `POST /webhooks/payments/mercado-pago`
