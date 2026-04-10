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

- `NODE_ENV`
- `PORT`
- `HOST`
- `CORS_ORIGINS`
- `LOG_LEVEL`

The server fails at startup if any required value is missing or invalid.

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
- Set `PORT=3000`.
- Expose container port `3000`.
- After deploy, verify:
  - `GET /health`
  - `GET /health/ready`
