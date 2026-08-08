import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, createConfig } from "./config.js";

test("createConfig parses valid environment values", () => {
  const config = createConfig({
    NODE_ENV: "development",
    PORT: "3000",
    HOST: "0.0.0.0",
    CORS_ORIGINS: "http://localhost:5173,https://app.example.com",
    LOG_LEVEL: "info",
    N8N_BASE_URL: "https://n8n.example.com",
    N8N_TIMEOUT_MS: "5000",
    VAPT_APP_ENDPOINT_SECRET: "app-secret",
    VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
    VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
    STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
    SUPABASE_URL: "https://supabase.example.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_JWT_SECRET: "jwt-secret",
  });

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.port, 3000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logLevel, "info");
  assert.deepEqual(config.corsOrigins, [
    "http://localhost:5173",
    "https://app.example.com",
  ]);
  assert.equal(config.n8n.baseUrl.toString(), "https://n8n.example.com/");
  assert.equal(config.n8n.timeoutMs, 5000);
  assert.equal(config.n8n.secrets.app, "app-secret");
  assert.equal(config.webhooks.stripe.signingSecret, "whsec_test");
  assert.equal(config.webhooks.stripe.toleranceSeconds, 300);
  assert.equal(config.supabase.url.toString(), "https://supabase.example.com/");
  assert.deepEqual(config.paymentEffects, {
    pollIntervalMs: 5_000,
    batchSize: 25,
    leaseMs: 60_000,
    maxAttempts: 5,
    retryBaseMs: 30_000,
  });
});

test("createConfig falls back to safe infrastructure defaults", () => {
  const config = createConfig({
    CORS_ORIGINS: "http://localhost:5173",
    N8N_BASE_URL: "https://n8n.example.com",
    N8N_TIMEOUT_MS: "5000",
    VAPT_APP_ENDPOINT_SECRET: "app-secret",
    VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
    VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
    STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
    SUPABASE_URL: "https://supabase.example.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_JWT_SECRET: "jwt-secret",
  });

  assert.equal(config.nodeEnv, "production");
  assert.equal(config.port, 3000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logLevel, "info");
});

test("createConfig throws when a required env is missing", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "3000",
        LOG_LEVEL: "info",
        N8N_BASE_URL: "https://n8n.example.com",
        N8N_TIMEOUT_MS: "5000",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_JWT_SECRET: "jwt-secret",
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
        N8N_BASE_URL: "https://n8n.example.com",
        N8N_TIMEOUT_MS: "5000",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_JWT_SECRET: "jwt-secret",
      }),
    ConfigError,
  );
});

test("createConfig throws when cors origins is empty", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "3000",
        HOST: "0.0.0.0",
        CORS_ORIGINS: "   ",
        LOG_LEVEL: "info",
        N8N_BASE_URL: "https://n8n.example.com",
        N8N_TIMEOUT_MS: "5000",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_JWT_SECRET: "jwt-secret",
      }),
    ConfigError,
  );
});

test("createConfig throws when n8n base url is invalid", () => {
  assert.throws(
    () =>
      createConfig({
        CORS_ORIGINS: "http://localhost:5173",
        N8N_BASE_URL: "not-a-url",
        N8N_TIMEOUT_MS: "5000",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_JWT_SECRET: "jwt-secret",
      }),
    ConfigError,
  );
});

test("createConfig throws when n8n timeout is invalid", () => {
  assert.throws(
    () =>
      createConfig({
        CORS_ORIGINS: "http://localhost:5173",
        N8N_BASE_URL: "https://n8n.example.com",
        N8N_TIMEOUT_MS: "0",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_JWT_SECRET: "jwt-secret",
      }),
    ConfigError,
  );
});

test("createConfig throws when supabase jwt secret is missing", () => {
  assert.throws(
    () =>
      createConfig({
        CORS_ORIGINS: "http://localhost:5173",
        N8N_BASE_URL: "https://n8n.example.com",
        N8N_TIMEOUT_MS: "5000",
        VAPT_APP_ENDPOINT_SECRET: "app-secret",
        VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
        VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
        SUPABASE_URL: "https://supabase.example.com",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      }),
    ConfigError,
  );
});

test("createConfig enables Mercado Pago only with a complete secure configuration", () => {
  const encryptionKey = Buffer.alloc(32, 4).toString("base64");
  const config = createConfig({
    CORS_ORIGINS: "https://app.vapt.test",
    N8N_BASE_URL: "https://n8n.example.com",
    N8N_TIMEOUT_MS: "5000",
    VAPT_APP_ENDPOINT_SECRET: "app-secret",
    VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
    VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
    STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
    SUPABASE_URL: "https://supabase.example.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_JWT_SECRET: "jwt-secret",
    MERCADO_PAGO_CLIENT_ID: "app-123",
    MERCADO_PAGO_CLIENT_SECRET: "client-secret",
    MERCADO_PAGO_REDIRECT_URI: "https://api.vapt.test/payments/mercado-pago/oauth/callback",
    MERCADO_PAGO_WEBHOOK_SECRET: "webhook-secret",
    PAYMENT_TOKEN_ENCRYPTION_KEY: encryptionKey,
    FRONTEND_URL: "https://app.vapt.test",
    API_PUBLIC_URL: "https://api.vapt.test",
  });

  assert.equal(config.mercadoPago?.clientId, "app-123");
  assert.equal(config.mercadoPago?.clientSecret, "client-secret");
  assert.equal(
    config.mercadoPago?.redirectUri.toString(),
    "https://api.vapt.test/payments/mercado-pago/oauth/callback",
  );
  assert.deepEqual(config.mercadoPago?.tokenEncryptionKey, Buffer.alloc(32, 4));
  assert.equal(config.mercadoPago?.credentialKeyId, "env-v1");
  assert.equal(config.mercadoPago?.environment, "sandbox");
  assert.equal(config.frontendUrl?.toString(), "https://app.vapt.test/");
  assert.equal(config.apiPublicUrl?.toString(), "https://api.vapt.test/");
});

test("createConfig rejects partial Mercado Pago configuration", () => {
  assert.throws(
    () => createConfig({
      CORS_ORIGINS: "https://app.vapt.test",
      N8N_BASE_URL: "https://n8n.example.com",
      N8N_TIMEOUT_MS: "5000",
      VAPT_APP_ENDPOINT_SECRET: "app-secret",
      VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
      VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
      STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      SUPABASE_JWT_SECRET: "jwt-secret",
      MERCADO_PAGO_CLIENT_ID: "app-123",
    }),
    ConfigError,
  );
});
test("createConfig rejects a Mercado Pago redirect outside API_PUBLIC_URL", () => {
  assert.throws(
    () => createConfig({
      CORS_ORIGINS: "https://app.vapt.test",
      N8N_BASE_URL: "https://n8n.example.com",
      N8N_TIMEOUT_MS: "5000",
      VAPT_APP_ENDPOINT_SECRET: "app-secret",
      VAPT_WEBHOOK_SETUP_SECRET: "setup-secret",
      VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
      STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      SUPABASE_JWT_SECRET: "jwt-secret",
      MERCADO_PAGO_CLIENT_ID: "app-123",
      MERCADO_PAGO_CLIENT_SECRET: "client-secret",
      MERCADO_PAGO_REDIRECT_URI: "https://evil.example.com/oauth/callback",
      MERCADO_PAGO_WEBHOOK_SECRET: "webhook-secret",
      PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      FRONTEND_URL: "https://app.vapt.test",
      API_PUBLIC_URL: "https://api.vapt.test",
    }),
    ConfigError,
  );
});