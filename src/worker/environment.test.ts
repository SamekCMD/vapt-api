import assert from "node:assert/strict";
import test from "node:test";

import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";

const validPreview = {
  ENVIRONMENT: "preview",
  HYPERDRIVE: { connectionString: "postgresql://preview:synthetic@db.vapt.test/vapt" },
  CORS_ORIGINS: "https://preview.vapt.test",
  FRONTEND_URL: "https://preview.vapt.test",
  STRIPE_SECRET_KEY: "sk_test_synthetic",
  STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
  STRIPE_ENVIRONMENT: "test",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_synthetic",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_BUSINESS: "price_business",
  PUBLIC_ORDER_TOKEN_SECRET: "synthetic-order-secret",
  BETTER_AUTH_SECRET: "synthetic-better-auth-secret-with-32-characters",
  BETTER_AUTH_URL: "https://api-preview.vapt.test",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://preview.vapt.test",
  TURNSTILE_SECRET_KEY: "synthetic-turnstile",
  RESEND_API_KEY: "re_synthetic",
  RESEND_TEMPLATE_VERIFY_ACCOUNT: "template_verify",
  RESEND_TEMPLATE_RESET_PASSWORD: "template_reset",
  EMAIL_FROM: "Vapt <noreply@vapt.test>",
} as const;

test("Worker configuration rejects missing Hyperdrive without leaking secret bindings", () => {
  assert.throws(
    () => configFromWorkerBindings({ ...validPreview, HYPERDRIVE: undefined } as WorkerBindings),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HYPERDRIVE/);
      assert.doesNotMatch(error.message, /sk_test_synthetic|re_synthetic/);
      return true;
    },
  );
});

test("Worker preview uses Hyperdrive URL and production validation", () => {
  const config = configFromWorkerBindings(validPreview as WorkerBindings);
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.betterAuth.databaseUrl, "postgresql://preview:synthetic@db.vapt.test/vapt");
  assert.equal(config.stripe.environment, "test");
  assert.deepEqual(config.corsOrigins, ["https://preview.vapt.test"]);
});

test("Worker preview rejects Stripe live mode but production permits test mode", () => {
  assert.throws(
    () => configFromWorkerBindings({ ...validPreview, STRIPE_ENVIRONMENT: "live" } as WorkerBindings),
    /preview/i,
  );
  const config = configFromWorkerBindings({ ...validPreview, ENVIRONMENT: "production" } as WorkerBindings);
  assert.equal(config.stripe.environment, "test");
});

test("Worker optional R2 and Mercado Pago groups preserve complete-only validation", () => {
  assert.throws(
    () => configFromWorkerBindings({ ...validPreview, R2_ACCOUNT_ID: "account" } as WorkerBindings),
    /R2_ACCESS_KEY_ID/,
  );
  assert.throws(
    () => configFromWorkerBindings({ ...validPreview, MERCADO_PAGO_CLIENT_ID: "client" } as WorkerBindings),
    /MERCADO_PAGO_CLIENT_SECRET/,
  );
  const config = configFromWorkerBindings({
    ...validPreview,
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
    R2_BUCKET_NAME: "preview-bucket",
    R2_PUBLIC_BASE_URL: "https://images.vapt.test",
    MERCADO_PAGO_CLIENT_ID: "client",
    MERCADO_PAGO_CLIENT_SECRET: "synthetic-client-secret",
    MERCADO_PAGO_REDIRECT_URI: "https://api-preview.vapt.test/callback",
    MERCADO_PAGO_WEBHOOK_SECRET: "synthetic-webhook-secret",
    PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    API_PUBLIC_URL: "https://api-preview.vapt.test",
  } as WorkerBindings);
  assert.equal(config.r2?.bucketName, "preview-bucket");
  assert.equal(config.mercadoPago?.clientId, "client");
});
