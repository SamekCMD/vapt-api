# Vapt API Phase 2 n8n Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centralized internal n8n client to `vapt-api` with strict config, an explicit route catalog, automatic auth-header selection, timeout handling, and normalized upstream failures.

**Architecture:** Extend `lib/config` with n8n settings, define the approved route catalog in `modules/n8n/contracts`, keep transport execution in `modules/n8n/client`, and normalize upstream failures in `modules/n8n/errors`. Do not expose new public API routes yet; Phase 2 is transport-only.

**Tech Stack:** Node.js, TypeScript, Fastify, global fetch, node:http test servers, node:test

---

## File Map

- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/contracts.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/errors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/client.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/client.test.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/index.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

### Task 1: Extend config with required n8n settings

**Files:**
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/lib/config.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/.env.example`

- [ ] **Step 1: Write failing config tests for valid n8n settings and missing required secrets**

```ts
test("createConfig parses valid n8n configuration", () => {
  const config = createConfig({
    CORS_ORIGINS: "http://localhost:5173",
    N8N_BASE_URL: "https://n8n.example.com",
    N8N_TIMEOUT_MS: "5000",
    VAPT_APP_ENDPOINT_SECRET: "app-secret",
    VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
    VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
  });

  assert.equal(config.n8n.baseUrl.toString(), "https://n8n.example.com/");
  assert.equal(config.n8n.timeoutMs, 5000);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`
Expected: config tests fail because the n8n properties do not exist yet.

- [ ] **Step 3: Implement n8n config parsing**

```ts
type N8nConfig = {
  baseUrl: URL;
  timeoutMs: number;
  secrets: {
    app: string;
    webhookSetup: string;
    admin: string;
  };
};
```

- [ ] **Step 4: Update `.env.example`**

```dotenv
N8N_BASE_URL=https://n8n.example.com
N8N_TIMEOUT_MS=5000
VAPT_APP_ENDPOINT_SECRET=replace-me
VAPT_WEBHOOK_SETUP_SECRET=replace-me
VAPT_ADMIN_ENDPOINT_SECRET=replace-me
```

- [ ] **Step 5: Re-run tests to verify GREEN**

Run: `npm test`
Expected: config tests pass.

### Task 2: Define the route catalog

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/contracts.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/client.test.ts`

- [ ] **Step 1: Write a failing test that asserts the approved route catalog exists**

```ts
test("n8n route catalog covers all approved operations", () => {
  assert.deepEqual(Object.keys(n8nContracts).sort(), [
    "asaas.pixCreate",
    "asaas.setup",
    "asaas.setupRefresh",
    "asaas.setupStatus",
    "ingest.orderFeedback",
    "ingest.pushSubscription",
    "stripe.health",
    "stripe.subscriptionCancel",
    "stripe.subscriptionChange",
    "stripe.subscriptionCreate",
    "stripe.subscriptionStatus",
  ]);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`
Expected: test fails because the catalog file does not exist yet.

- [ ] **Step 3: Implement the route catalog**

```ts
export const n8nContracts = {
  "asaas.setup": { method: "POST", path: "/asaas/setup", auth: "webhookSetup" },
  // ...
} as const;
```

- [ ] **Step 4: Re-run tests to verify GREEN**

Run: `npm test`
Expected: route catalog test passes.

### Task 3: Build the transport client and normalize success/error behavior

**Files:**
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/errors.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/client.ts`
- Create: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/index.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/modules/n8n/client.test.ts`

- [ ] **Step 1: Write failing transport tests for header selection, timeout, upstream error, and invalid JSON**

```ts
test("client sends x-vapt-app-key for app routes", async () => {
  // start local server, capture headers, call stripe.subscriptionCreate
});

test("client sends x-vapt-webhook-key for asaas setup", async () => {
  // start local server, capture headers, call asaas.setup
});

test("client times out slow upstream requests", async () => {
  // start local hanging server, call client, expect N8nClientError('upstream_timeout')
});

test("client normalizes upstream non-2xx responses", async () => {
  // server returns 500 JSON, expect N8nClientError('upstream_error')
});

test("client rejects invalid upstream json responses", async () => {
  // server returns application/json with invalid body, expect N8nClientError('invalid_upstream_response')
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`
Expected: transport tests fail because the client does not exist yet.

- [ ] **Step 3: Implement normalized client execution**

```ts
export async function callN8nOperation(operation, options) {
  const contract = n8nContracts[operation];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.n8n.timeoutMs);
  // execute fetch, parse response, normalize failure, clear timeout
}
```

- [ ] **Step 4: Export the module entrypoint**

```ts
export { createN8nClient } from "./client.js";
export { n8nContracts } from "./contracts.js";
export { N8nClientError } from "./errors.js";
```

- [ ] **Step 5: Re-run tests to verify GREEN**

Run: `npm test`
Expected: transport tests pass.

### Task 4: Align app-level typing and docs

**Files:**
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/src/app.test.ts`
- Modify: `D:/Projetos/vaptmesaflow/vapt-api/README.md`

- [ ] **Step 1: Update app test config fixtures with the required n8n config**

```ts
const validConfig: AppConfig = {
  // existing fields...
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: {
      app: "app-secret",
      webhookSetup: "setup-secret",
      admin: "admin-secret",
    },
  },
};
```

- [ ] **Step 2: Document the new required environment variables**

```md
- `N8N_BASE_URL`
- `N8N_TIMEOUT_MS`
- `VAPT_APP_ENDPOINT_SECRET`
- `VAPT_WEBHOOK_SETUP_SECRET`
- `VAPT_ADMIN_ENDPOINT_SECRET`
```

### Task 5: Verification gate

**Files:**
- Review only: all Phase 2 files

- [ ] **Step 1: Run tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 3: Run a startup failure check for missing n8n config**

Run: start the server without `N8N_BASE_URL`
Expected: process exits with a config error.
