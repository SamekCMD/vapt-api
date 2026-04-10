# Vapt API Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict runtime configuration, structured logging, standardized error handling, restricted CORS, and initial backend folder organization to `vapt-api`.

**Architecture:** Keep the service small and explicit. Centralize startup validation in `lib/config`, keep cross-cutting Fastify runtime behavior in `plugins`, move health routes into `modules/health`, and keep `server.ts` limited to process boot. Add only the minimal dependencies needed for these foundations.

**Tech Stack:** Node.js, TypeScript, Fastify, @fastify/cors, Pino, node:test, tsx, Docker

---

## File Map

- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/errors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/cors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/error-handler.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/logger.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/health/routes.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/server.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/package.json`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

### Task 1: Add strict runtime configuration

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`

- [ ] **Step 1: Write the failing config tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createConfig, ConfigError } from "./config.js";

test("createConfig parses valid environment values", () => {
  const config = createConfig({
    NODE_ENV: "development",
    PORT: "3000",
    HOST: "0.0.0.0",
    CORS_ORIGINS: "http://localhost:5173,https://app.example.com",
    LOG_LEVEL: "info",
  });

  assert.equal(config.port, 3000);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(config.corsOrigins, [
    "http://localhost:5173",
    "https://app.example.com",
  ]);
});

test("createConfig throws when a required env is missing", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "3000",
        HOST: "0.0.0.0",
        LOG_LEVEL: "info",
      }),
    ConfigError,
  );
});

test("createConfig throws when port is invalid", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "abc",
        HOST: "0.0.0.0",
        CORS_ORIGINS: "http://localhost:5173",
        LOG_LEVEL: "info",
      }),
    ConfigError,
  );
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test`
Expected: failure because `src/lib/config.ts` does not exist yet.

- [ ] **Step 3: Implement the config parser and error type**

```ts
const validNodeEnvs = new Set(["development", "test", "production"]);
const validLogLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

export class ConfigError extends Error {}

export function createConfig(env: NodeJS.ProcessEnv) {
  // parse, validate, and return typed config
}
```

- [ ] **Step 4: Update `.env.example` with all required Phase 1 values**

```dotenv
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
CORS_ORIGINS=http://localhost:5173
LOG_LEVEL=info
```

- [ ] **Step 5: Re-run tests to verify GREEN**

Run: `npm test`
Expected: config tests pass.

### Task 2: Add health module and app error primitives

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/errors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/health/routes.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`

- [ ] **Step 1: Extend the app tests with not-found and known-error expectations**

```ts
test("unknown routes return standardized not_found errors", async () => {
  const app = buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/missing",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: "not_found",
      message: "Route not found",
    },
  });

  await app.close();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test`
Expected: new route/error assertions fail with the current implementation.

- [ ] **Step 3: Create `AppError` and move health routes into a module**

```ts
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
```

```ts
import { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready" }));
}
```

- [ ] **Step 4: Re-run tests to verify partial GREEN**

Run: `npm test`
Expected: health tests still pass; not-found still fails until handlers are added.

### Task 3: Add logger, CORS, and global error handling plugins

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/logger.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/cors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/plugins/error-handler.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/package.json`

- [ ] **Step 1: Add failing app tests for CORS allow/deny behavior**

```ts
test("allowed CORS origin is echoed back", async () => {
  const app = buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "http://localhost:5173",
    },
  });

  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");

  await app.close();
});

test("blocked CORS origin is rejected", async () => {
  const app = buildApp(validConfig);

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: {
      origin: "https://evil.example.com",
    },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });

  await app.close();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test`
Expected: CORS assertions fail because the plugin is not registered yet.

- [ ] **Step 3: Add the dependencies and implement the plugins**

```json
{
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "fastify": "^5.2.1"
  }
}
```

```ts
export function createLoggerConfig(config: AppConfig) {
  return {
    level: config.logLevel,
    transport: config.nodeEnv === "development"
      ? { target: "pino-pretty" }
      : undefined,
  };
}
```

```ts
export async function registerCors(app: FastifyInstance, config: AppConfig) {
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed"));
    },
  });
}
```

```ts
export function registerErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    // normalize AppError vs unknown errors
  });
}
```

- [ ] **Step 4: Recompose the app around config, plugins, and route registration**

```ts
export function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: createLoggerConfig(config),
  });

  await registerCors(app, config);
  registerErrorHandler(app);
  await registerHealthRoutes(app);

  return app;
}
```

- [ ] **Step 5: Re-run tests to verify GREEN**

Run: `npm test`
Expected: CORS, health, and not-found tests pass.

### Task 4: Wire startup to strict config and update docs

**Files:**
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/server.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

- [ ] **Step 1: Update `server.ts` to load config before boot**

```ts
import { getConfig } from "./lib/config.js";

const config = getConfig();
const app = await buildApp(config);
await app.listen({ host: config.host, port: config.port });
```

- [ ] **Step 2: Document the required env and restricted CORS behavior**

```md
Required env:
- `NODE_ENV`
- `PORT`
- `HOST`
- `CORS_ORIGINS`
- `LOG_LEVEL`

The server fails at startup if any required value is missing or invalid.
```

### Task 5: Verification gate

**Files:**
- Review only: all Phase 1 files

- [ ] **Step 1: Run tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 3: Run the server with valid env and hit `/health`**

Run: `node dist/server.js`
Expected: service starts and responds to `/health`.

- [ ] **Step 4: Run the server with invalid env and confirm boot fails**

Run: start with `CORS_ORIGINS=` or missing `HOST`
Expected: process exits with config error.
