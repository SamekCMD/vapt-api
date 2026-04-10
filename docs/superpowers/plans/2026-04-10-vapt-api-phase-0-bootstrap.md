# Vapt API Phase 0 Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap `vapt-api` as a minimal, deployable Fastify service with health endpoints and Docker packaging.

**Architecture:** Keep the backend intentionally small in Phase 0. Export a Fastify app builder for testability, keep runtime bootstrapping in a separate server entrypoint, and package the compiled service in a lightweight Node 18 Alpine image.

**Tech Stack:** Node.js, TypeScript, Fastify, tsx, node:test, Docker

---

## File Map

- Create: `D:/Projetos/vaptmesaflow/vapt-api/package.json`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/tsconfig.json`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/.gitignore`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/Dockerfile`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/app.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`
- Create: `D:/Projetos\vaptmesaflow\vapt-api\src\server.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

### Task 1: Define package and compiler baseline

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/package.json`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/tsconfig.json`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/.gitignore`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`

- [ ] **Step 1: Add the package manifest with runtime and dev scripts**

```json
{
  "name": "vapt-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "tsx --test src/**/*.test.ts"
  }
}
```

- [ ] **Step 2: Add a compiler config that emits `dist/`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add ignore and env template files**

```gitignore
node_modules
dist
.env
```

```dotenv
PORT=3000
```

### Task 2: Add a failing health-route test first

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`

- [ ] **Step 1: Write a failing test for the health endpoints**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("GET /health returns ok", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});

test("GET /health/ready returns ready", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready" });

  await app.close();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test`
Expected: failure because `src/app.ts` does not exist yet.

### Task 3: Implement the minimal Fastify app

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/app.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/server.ts`

- [ ] **Step 1: Add the smallest app builder that satisfies the tests**

```ts
import Fastify from "fastify";

export function buildApp() {
  const app = Fastify();

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/health/ready", async () => {
    return { status: "ready" };
  });

  return app;
}
```

- [ ] **Step 2: Add the runtime server entrypoint**

```ts
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = "0.0.0.0";

async function start() {
  const app = buildApp();

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
```

- [ ] **Step 3: Run the tests to verify GREEN**

Run: `npm test`
Expected: both tests pass.

### Task 4: Package the service for Docker and document usage

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/Dockerfile`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

- [ ] **Step 1: Add a multi-stage Dockerfile for compiled runtime**

```dockerfile
FROM node:18-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Replace the placeholder README with local and EasyPanel instructions**

```md
# vapt-api

Minimal backend service for Vapt.

## Requirements

- Node.js 18+
- npm
- Docker

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`.

3. Start the dev server:

```bash
npm run dev
```

The API listens on `0.0.0.0:${PORT:-3000}`.

## Build and run

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t vapt-api .
docker run --rm -p 3000:3000 --env-file .env vapt-api
```

## EasyPanel

- Create a new app from the repository.
- Use the provided `Dockerfile`.
- Set `PORT=3000`.
- Expose port `3000`.
- After deploy, verify:
  - `GET /health`
  - `GET /health/ready`
```

### Task 5: Verification gate

**Files:**
- Review only: all created Phase 0 files

- [ ] **Step 1: Run tests**

Run: `npm test`
Expected: 2 tests pass, 0 fail.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`
Expected: exit code 0 and `dist/` emitted.

- [ ] **Step 3: Sanity-check the production entrypoint**

Run: `npm start`
Expected: server starts on `0.0.0.0:3000` or env-defined port.

- [ ] **Step 4: Build the Docker image**

Run: `docker build -t vapt-api .`
Expected: successful image build with exposed port 3000.
