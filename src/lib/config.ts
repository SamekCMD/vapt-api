import { parseSecretEncryptionKey } from "./crypto.js";
import type { PaymentEnvironment } from "../modules/payments/types.js";

const validNodeEnvs = new Set(["development", "test", "production"]);
const validPaymentEnvironments = new Set<PaymentEnvironment>(["sandbox", "production"]);
const validStripeEnvironments = new Set<StripeEnvironment>(["test", "live"]);
const validLogLevels = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

export type BetterAuthConfig = {
  secret: string;
  url: URL;
  trustedOrigins: string[];
  databaseUrl: string;
  turnstileSecretKey: string;
  email: {
    resendApiKey: string;
    from: string;
    verifyAccountTemplate: string;
    resetPasswordTemplate: string;
  };
};

export type StripeEnvironment = "test" | "live";

export type StripeBillingConfig = {
  secretKey: string;
  webhookSecret: string;
  webhookToleranceSeconds: number;
  environment: StripeEnvironment;
  portalConfigurationId: string;
  prices: Record<"starter" | "pro" | "business", string>;
};

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  corsOrigins: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  stripe: StripeBillingConfig;
  paymentEffects?: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    maxAttempts: number;
    retryBaseMs: number;
  };
  frontendUrl: URL;
  apiPublicUrl?: URL;
  mercadoPago?: {
    clientId: string;
    clientSecret: string;
    redirectUri: URL;
    webhookSecret: string;
    tokenEncryptionKey: Buffer;
    credentialKeyId: string;
    environment: PaymentEnvironment;
    testAccessToken?: string;
  };
  security: {
    publicOrderTokenSecret: string;
    paymentEffectsAdminSecret?: string;
  };
  betterAuth: BetterAuthConfig;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    publicBaseUrl: URL;
    uploadUrlTtlSeconds: number;
  };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

function getValueOrDefault(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];

  if (!value || value.trim() === "") {
    return fallback;
  }

  return value.trim();
}

function parsePort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be a valid integer between 1 and 65535");
  }

  return port;
}

function parseCorsOrigins(value: string): string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new ConfigError("CORS_ORIGINS must contain at least one allowed origin");
  }

  return origins;
}

function parseTrustedOrigins(value: string): string[] {
  const entries = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new ConfigError(
      "BETTER_AUTH_TRUSTED_ORIGINS must contain at least one allowed origin",
    );
  }

  const origins = entries.map((entry) => {
    const url = parseUrl(entry, "BETTER_AUTH_TRUSTED_ORIGINS");

    if (url.origin === "null") {
      throw new ConfigError(
        "BETTER_AUTH_TRUSTED_ORIGINS must contain absolute HTTP or HTTPS URLs",
      );
    }

    return url.origin;
  });

  if (new Set(origins).size !== origins.length) {
    throw new ConfigError(
      "BETTER_AUTH_TRUSTED_ORIGINS must not contain duplicate origins",
    );
  }

  return origins;
}

function parseUrl(value: string, key: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigError(`${key} must be a valid absolute URL`);
  }
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }

  return parsed;
}

function parseIntegerRange(value: string, key: string, minimum: number, maximum: number): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function parsePublicHttpsUrl(value: string, key: string): URL {
  const url = parseUrl(value, key);

  if (url.protocol !== "https:") {
    throw new ConfigError(`${key} must use https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${key} must not contain credentials, a query string, or a fragment`);
  }

  return url;
}

function parsePaymentEnvironment(value: string): PaymentEnvironment {
  if (!validPaymentEnvironments.has(value as PaymentEnvironment)) {
    throw new ConfigError("MERCADO_PAGO_ENVIRONMENT must be one of: sandbox, production");
  }
  return value as PaymentEnvironment;
}

function parseStripeEnvironment(value: string): StripeEnvironment {
  if (!validStripeEnvironments.has(value as StripeEnvironment)) {
    throw new ConfigError("STRIPE_ENVIRONMENT must be one of: test, live");
  }

  return value as StripeEnvironment;
}

function parseStripePortalConfigurationId(value: string): string {
  if (!/^bpc_[A-Za-z0-9]+$/.test(value)) {
    throw new ConfigError("STRIPE_PORTAL_CONFIGURATION_ID must start with bpc_");
  }

  return value;
}

function parseFrontendUrl(value: string, nodeEnv: string): URL {
  const url = parseUrl(value, "FRONTEND_URL");
  const localDevelopment =
    nodeEnv === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (url.protocol !== "https:" && !localDevelopment) {
    throw new ConfigError("FRONTEND_URL must use https outside local development");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      "FRONTEND_URL must not contain credentials, a query string, or a fragment",
    );
  }

  return url;
}

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = getValueOrDefault(env, "NODE_ENV", "production");
  const port = getValueOrDefault(env, "PORT", "3000");
  const host = getValueOrDefault(env, "HOST", "0.0.0.0");
  const corsOrigins = requireValue(env, "CORS_ORIGINS");
  const logLevel = getValueOrDefault(env, "LOG_LEVEL", "info");
  const paymentEffectsPollIntervalMs = getValueOrDefault(env, "PAYMENT_EFFECTS_POLL_INTERVAL_MS", "5000");
  const paymentEffectsBatchSize = getValueOrDefault(env, "PAYMENT_EFFECTS_BATCH_SIZE", "25");
  const paymentEffectsLeaseMs = getValueOrDefault(env, "PAYMENT_EFFECTS_LEASE_MS", "60000");
  const paymentEffectsMaxAttempts = getValueOrDefault(env, "PAYMENT_EFFECTS_MAX_ATTEMPTS", "5");
  const paymentEffectsRetryBaseMs = getValueOrDefault(env, "PAYMENT_EFFECTS_RETRY_BASE_MS", "30000");
  const stripeSecretKey = requireValue(env, "STRIPE_SECRET_KEY");
  const stripeWebhookSecret = requireValue(env, "STRIPE_WEBHOOK_SECRET");
  const stripeEnvironment = requireValue(env, "STRIPE_ENVIRONMENT");
  const stripePortalConfigurationId = requireValue(
    env,
    "STRIPE_PORTAL_CONFIGURATION_ID",
  );
  const stripePriceStarter = requireValue(env, "STRIPE_PRICE_STARTER");
  const stripePricePro = requireValue(env, "STRIPE_PRICE_PRO");
  const stripePriceBusiness = requireValue(env, "STRIPE_PRICE_BUSINESS");
  const stripeWebhookToleranceSeconds = getValueOrDefault(
    env,
    "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
    "300",
  );
  const frontendUrl = requireValue(env, "FRONTEND_URL");
  const publicOrderTokenSecret = requireValue(env, "PUBLIC_ORDER_TOKEN_SECRET");
  const paymentEffectsAdminSecret = env.PAYMENT_EFFECTS_ADMIN_SECRET?.trim() || undefined;
  if (paymentEffectsAdminSecret && paymentEffectsAdminSecret.length < 32) {
    throw new ConfigError("PAYMENT_EFFECTS_ADMIN_SECRET must contain at least 32 characters");
  }
  const betterAuthSecret = requireValue(env, "BETTER_AUTH_SECRET");
  const betterAuthUrl = requireValue(env, "BETTER_AUTH_URL");
  const betterAuthTrustedOrigins = requireValue(
    env,
    "BETTER_AUTH_TRUSTED_ORIGINS",
  );
  const databaseUrl = requireValue(env, "DATABASE_URL");
  const turnstileSecretKey = requireValue(env, "TURNSTILE_SECRET_KEY");
  const resendApiKey = requireValue(env, "RESEND_API_KEY");
  const verifyAccountTemplate = requireValue(
    env,
    "RESEND_TEMPLATE_VERIFY_ACCOUNT",
  );
  const resetPasswordTemplate = requireValue(
    env,
    "RESEND_TEMPLATE_RESET_PASSWORD",
  );
  const emailFrom = requireValue(env, "EMAIL_FROM");

  if (betterAuthSecret.length < 32) {
    throw new ConfigError(
      "BETTER_AUTH_SECRET must contain at least 32 characters",
    );
  }
  const r2Keys = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL",
  ] as const;
  const r2Enabled = r2Keys.some((key) => Boolean(env[key]?.trim()));
  const r2 = r2Enabled
    ? {
        accountId: requireValue(env, "R2_ACCOUNT_ID"),
        accessKeyId: requireValue(env, "R2_ACCESS_KEY_ID"),
        secretAccessKey: requireValue(env, "R2_SECRET_ACCESS_KEY"),
        bucketName: requireValue(env, "R2_BUCKET_NAME"),
        publicBaseUrl: parsePublicHttpsUrl(
          requireValue(env, "R2_PUBLIC_BASE_URL"),
          "R2_PUBLIC_BASE_URL",
        ),
        uploadUrlTtlSeconds: parseIntegerRange(
          getValueOrDefault(env, "R2_UPLOAD_URL_TTL_SECONDS", "300"),
          "R2_UPLOAD_URL_TTL_SECONDS",
          60,
          900,
        ),
      }
    : undefined;
  const mercadoPagoKeys = [
    "MERCADO_PAGO_CLIENT_ID",
    "MERCADO_PAGO_CLIENT_SECRET",
    "MERCADO_PAGO_REDIRECT_URI",
    "MERCADO_PAGO_WEBHOOK_SECRET",
    "PAYMENT_TOKEN_ENCRYPTION_KEY",
  ] as const;
  const mercadoPagoEnabled = mercadoPagoKeys.some((key) => Boolean(env[key]?.trim()));
  const mercadoPagoEnvironment = parsePaymentEnvironment(
    getValueOrDefault(env, "MERCADO_PAGO_ENVIRONMENT", "sandbox"),
  );
  const mercadoPagoTestAccessToken = env.MERCADO_PAGO_TEST_ACCESS_TOKEN?.trim() || undefined;
  if (mercadoPagoTestAccessToken && mercadoPagoEnvironment !== "sandbox") {
    throw new ConfigError(
      "MERCADO_PAGO_TEST_ACCESS_TOKEN can only be used in sandbox",
    );
  }
  const mercadoPago = mercadoPagoEnabled
    ? {
        clientId: requireValue(env, "MERCADO_PAGO_CLIENT_ID"),
        clientSecret: requireValue(env, "MERCADO_PAGO_CLIENT_SECRET"),
        redirectUri: parseUrl(
          requireValue(env, "MERCADO_PAGO_REDIRECT_URI"),
          "MERCADO_PAGO_REDIRECT_URI",
        ),
        webhookSecret: requireValue(env, "MERCADO_PAGO_WEBHOOK_SECRET"),
        tokenEncryptionKey: parseSecretEncryptionKey(
          requireValue(env, "PAYMENT_TOKEN_ENCRYPTION_KEY"),
        ),
        credentialKeyId: "env-v1",
        environment: mercadoPagoEnvironment,
        testAccessToken: mercadoPagoTestAccessToken,
      }
    : undefined;
  const apiPublicUrlValue = env.API_PUBLIC_URL?.trim();
  const apiPublicUrl = apiPublicUrlValue
    ? parseUrl(apiPublicUrlValue, "API_PUBLIC_URL")
    : mercadoPagoEnabled
      ? parseUrl(requireValue(env, "API_PUBLIC_URL"), "API_PUBLIC_URL")
      : undefined;
  if (
    mercadoPago &&
    apiPublicUrl &&
    mercadoPago.redirectUri.origin !== apiPublicUrl.origin
  ) {
    throw new ConfigError(
      "MERCADO_PAGO_REDIRECT_URI must use the API_PUBLIC_URL origin",
    );
  }

  if (!validNodeEnvs.has(nodeEnv)) {
    throw new ConfigError("NODE_ENV must be one of: development, test, production");
  }

  if (!validLogLevels.has(logLevel)) {
    throw new ConfigError("LOG_LEVEL must be a supported Pino level");
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port: parsePort(port),
    host,
    corsOrigins: parseCorsOrigins(corsOrigins),
    logLevel: logLevel as AppConfig["logLevel"],
    stripe: {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
      webhookToleranceSeconds: parsePositiveInteger(
        stripeWebhookToleranceSeconds,
        "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
      ),
      environment: parseStripeEnvironment(stripeEnvironment),
      portalConfigurationId: parseStripePortalConfigurationId(
        stripePortalConfigurationId,
      ),
      prices: {
        starter: stripePriceStarter,
        pro: stripePricePro,
        business: stripePriceBusiness,
      },
    },
    paymentEffects: {
      pollIntervalMs: parsePositiveInteger(paymentEffectsPollIntervalMs, "PAYMENT_EFFECTS_POLL_INTERVAL_MS"),
      batchSize: parsePositiveInteger(paymentEffectsBatchSize, "PAYMENT_EFFECTS_BATCH_SIZE"),
      leaseMs: parsePositiveInteger(paymentEffectsLeaseMs, "PAYMENT_EFFECTS_LEASE_MS"),
      maxAttempts: parsePositiveInteger(paymentEffectsMaxAttempts, "PAYMENT_EFFECTS_MAX_ATTEMPTS"),
      retryBaseMs: parsePositiveInteger(paymentEffectsRetryBaseMs, "PAYMENT_EFFECTS_RETRY_BASE_MS"),
    },
    frontendUrl: parseFrontendUrl(frontendUrl, nodeEnv),
    apiPublicUrl,
    mercadoPago,
    security: {
      publicOrderTokenSecret,
      paymentEffectsAdminSecret,
    },
    betterAuth: {
      secret: betterAuthSecret,
      url: parseUrl(betterAuthUrl, "BETTER_AUTH_URL"),
      trustedOrigins: parseTrustedOrigins(betterAuthTrustedOrigins),
      databaseUrl,
      turnstileSecretKey,
      email: {
        resendApiKey,
        from: emailFrom,
        verifyAccountTemplate,
        resetPasswordTemplate,
      },
    },
    r2,
  };
}

export function getConfig(): AppConfig {
  return createConfig(process.env);
}
