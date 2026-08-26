# vapt-api

Backend service for Vapt.

## Requirements

- Node.js 18 or newer
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
- `VAPT_WEBHOOK_SETUP_SECRET`
- `VAPT_ADMIN_ENDPOINT_SECRET`
- `STRIPE_WEBHOOK_SIGNING_SECRET`
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS` defaults to `300`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`
- `FRONTEND_URL`
- `API_PUBLIC_URL`
- `PAYMENT_TOKEN_ENCRYPTION_KEY`

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
Vercel previews can use one explicit wildcard in the deployment segment, while keeping
the project and team fixed, for example
`https://vaptmesaflow-*-contatoupboost-2301s-projects.vercel.app`. Wildcards are not
accepted for other domains.

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

## EasyPanel deploy

- Create an app from this repository.
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
