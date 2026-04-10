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
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`

The server fails at startup if any required sensitive value is missing or invalid.

3. Start the API:

```bash
npm run dev
```

The service listens on `0.0.0.0` and uses `PORT`, defaulting to `3000`.

`CORS_ORIGINS` must contain a comma-separated allowlist of approved browser origins.

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
- Optionally override `PORT`, `HOST`, `NODE_ENV`, and `LOG_LEVEL` if you need custom infrastructure behavior.
- Expose container port `3000`.
- After deploy, verify:
  - `GET /health`
  - `GET /health/ready`
