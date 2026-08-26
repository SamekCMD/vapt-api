import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, createConfig } from "./config.js";

test("createConfig rejects an unsupported Mercado Pago environment", () => {
  assert.throws(
    () => createConfig({
      CORS_ORIGINS: "https://app.vapt.test",
      N8N_BASE_URL: "https://n8n.example.com",
      N8N_TIMEOUT_MS: "5000",
      VAPT_APP_ENDPOINT_SECRET: "app-secret",
      VAPT_ADMIN_ENDPOINT_SECRET: "admin-secret",
      STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_test",
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      SUPABASE_JWT_SECRET: "jwt-secret",
      MERCADO_PAGO_CLIENT_ID: "app-123",
      MERCADO_PAGO_CLIENT_SECRET: "client-secret",
      MERCADO_PAGO_REDIRECT_URI: "https://api.vapt.test/payments/mercado-pago/oauth/callback",
      MERCADO_PAGO_WEBHOOK_SECRET: "webhook-secret",
      MERCADO_PAGO_ENVIRONMENT: "browser-controlled",
      PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      FRONTEND_URL: "https://app.vapt.test",
      API_PUBLIC_URL: "https://api.vapt.test",
    }),
    ConfigError,
  );
});
