import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, createConfig } from "./config.js";

test("createConfig rejects an unsupported Mercado Pago environment", () => {
  assert.throws(
    () => createConfig({
      CORS_ORIGINS: "https://app.vapt.test",
      STRIPE_SECRET_KEY: "sk_test_vapt",
      STRIPE_WEBHOOK_SECRET: "whsec_vapt",
      STRIPE_ENVIRONMENT: "test",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_vapt",
      STRIPE_PRICE_STARTER: "price_server_starter",
      STRIPE_PRICE_PRO: "price_server_pro",
      STRIPE_PRICE_BUSINESS: "price_server_business",
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      PUBLIC_ORDER_TOKEN_SECRET: "public-order-token-secret",
      BETTER_AUTH_SECRET: "better-auth-secret-at-least-32-characters",
      BETTER_AUTH_URL: "https://api.vapt.test",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.vapt.test",
      DATABASE_URL: "postgresql://vapt:password@db.vapt.test/vapt",
      TURNSTILE_SECRET_KEY: "turnstile-secret-key",
      RESEND_API_KEY: "re_test_key",
      RESEND_TEMPLATE_VERIFY_ACCOUNT: "verify-account-template",
      RESEND_TEMPLATE_RESET_PASSWORD: "reset-password-template",
      EMAIL_FROM: "Vapt <noreply@vapt.test>",
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
