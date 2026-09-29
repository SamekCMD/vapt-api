import { ConfigError, createConfig, type AppConfig } from "../lib/config.js";

const workerVariables = [
  "CORS_ORIGINS", "FRONTEND_URL", "API_PUBLIC_URL", "LOG_LEVEL",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_ENVIRONMENT",
  "STRIPE_PORTAL_CONFIGURATION_ID", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_BUSINESS", "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
  "PUBLIC_ORDER_TOKEN_SECRET", "PAYMENT_EFFECTS_ADMIN_SECRET",
  "PAYMENT_EFFECTS_POLL_INTERVAL_MS", "PAYMENT_EFFECTS_BATCH_SIZE",
  "PAYMENT_EFFECTS_LEASE_MS", "PAYMENT_EFFECTS_MAX_ATTEMPTS",
  "PAYMENT_EFFECTS_RETRY_BASE_MS", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY",
  "RESEND_TEMPLATE_VERIFY_ACCOUNT", "RESEND_TEMPLATE_RESET_PASSWORD", "EMAIL_FROM",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME",
  "R2_PUBLIC_BASE_URL", "R2_UPLOAD_URL_TTL_SECONDS", "MERCADO_PAGO_CLIENT_ID",
  "MERCADO_PAGO_CLIENT_SECRET", "MERCADO_PAGO_REDIRECT_URI",
  "MERCADO_PAGO_WEBHOOK_SECRET", "MERCADO_PAGO_ENVIRONMENT",
  "MERCADO_PAGO_TEST_ACCESS_TOKEN", "PAYMENT_TOKEN_ENCRYPTION_KEY",
] as const;

export type WorkerBindings = Partial<Record<(typeof workerVariables)[number], string>> & {
  ENVIRONMENT: "preview" | "production";
  HYPERDRIVE?: { connectionString: string };
  AUTH_RATE_LIMIT?: WorkerRateLimitBinding;
  BILLING_RATE_LIMIT?: WorkerRateLimitBinding;
  ORDERS_RATE_LIMIT?: WorkerRateLimitBinding;
  STORAGE_RATE_LIMIT?: WorkerRateLimitBinding;
  WEBHOOKS_RATE_LIMIT?: WorkerRateLimitBinding;
  PUBLIC_RATE_LIMIT?: WorkerRateLimitBinding;
};

export type WorkerRateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export function configFromWorkerBindings(env: WorkerBindings): AppConfig {
  if (env.ENVIRONMENT !== "preview" && env.ENVIRONMENT !== "production") {
    throw new ConfigError("ENVIRONMENT must be preview or production");
  }
  if (!env.HYPERDRIVE?.connectionString) {
    throw new ConfigError("Missing required Worker binding: HYPERDRIVE");
  }
  if (env.ENVIRONMENT === "preview" && env.STRIPE_ENVIRONMENT === "live") {
    throw new ConfigError("Stripe live mode is not allowed in preview");
  }

  const values: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DATABASE_URL: env.HYPERDRIVE.connectionString,
  };
  for (const key of workerVariables) {
    values[key] = env[key];
  }
  return createConfig(values);
}
