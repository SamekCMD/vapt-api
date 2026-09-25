import { parseSecretEncryptionKey } from "./crypto.js";
import type { PaymentEnvironment } from "../modules/payments/types.js";

const validNodeEnvs = new Set(["development", "test", "production"]);
const validPaymentEnvironments = new Set<PaymentEnvironment>(["sandbox", "production"]);
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

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  corsOrigins: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  n8n: {
    baseUrl: URL;
    timeoutMs: number;
    secrets: {
      app: string;
      admin: string;
    };
  };
  paymentEffects?: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    maxAttempts: number;
    retryBaseMs: number;
  };
  frontendUrl?: URL;
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
  webhooks: {
    stripe: {
      signingSecret: string;
      toleranceSeconds: number;
    };
  };
  security: {
    publicOrderTokenSecret: string;
  };
  betterAuth: BetterAuthConfig;
  supabase: {
    url: URL;
    serviceRoleKey: string;
    jwtSecret: string;
  };
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

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = getValueOrDefault(env, "NODE_ENV", "production");
  const port = getValueOrDefault(env, "PORT", "3000");
  const host = getValueOrDefault(env, "HOST", "0.0.0.0");
  const corsOrigins = requireValue(env, "CORS_ORIGINS");
  const logLevel = getValueOrDefault(env, "LOG_LEVEL", "info");
  const n8nBaseUrl = requireValue(env, "N8N_BASE_URL");
  const n8nTimeoutMs = requireValue(env, "N8N_TIMEOUT_MS");
  const appSecret = requireValue(env, "VAPT_APP_ENDPOINT_SECRET");
  const adminSecret = requireValue(env, "VAPT_ADMIN_ENDPOINT_SECRET");
  const paymentEffectsPollIntervalMs = getValueOrDefault(env, "PAYMENT_EFFECTS_POLL_INTERVAL_MS", "5000");
  const paymentEffectsBatchSize = getValueOrDefault(env, "PAYMENT_EFFECTS_BATCH_SIZE", "25");
  const paymentEffectsLeaseMs = getValueOrDefault(env, "PAYMENT_EFFECTS_LEASE_MS", "60000");
  const paymentEffectsMaxAttempts = getValueOrDefault(env, "PAYMENT_EFFECTS_MAX_ATTEMPTS", "5");
  const paymentEffectsRetryBaseMs = getValueOrDefault(env, "PAYMENT_EFFECTS_RETRY_BASE_MS", "30000");
  const stripeWebhookSigningSecret = requireValue(env, "STRIPE_WEBHOOK_SIGNING_SECRET");
  const stripeWebhookToleranceSeconds = getValueOrDefault(
    env,
    "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
    "300",
  );
  const supabaseUrl = requireValue(env, "SUPABASE_URL");
  const supabaseServiceRoleKey = requireValue(env, "SUPABASE_SERVICE_ROLE_KEY");
  const supabaseJwtSecret = requireValue(env, "SUPABASE_JWT_SECRET");
  const publicOrderTokenSecret = requireValue(env, "PUBLIC_ORDER_TOKEN_SECRET");
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
    "FRONTEND_URL",
    "API_PUBLIC_URL",
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
  const frontendUrl = mercadoPagoEnabled
    ? parseUrl(requireValue(env, "FRONTEND_URL"), "FRONTEND_URL")
    : undefined;
  const apiPublicUrl = mercadoPagoEnabled
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
    n8n: {
      baseUrl: parseUrl(n8nBaseUrl, "N8N_BASE_URL"),
      timeoutMs: parsePositiveInteger(n8nTimeoutMs, "N8N_TIMEOUT_MS"),
      secrets: {
        app: appSecret,
        admin: adminSecret,
      },
    },
    paymentEffects: {
      pollIntervalMs: parsePositiveInteger(paymentEffectsPollIntervalMs, "PAYMENT_EFFECTS_POLL_INTERVAL_MS"),
      batchSize: parsePositiveInteger(paymentEffectsBatchSize, "PAYMENT_EFFECTS_BATCH_SIZE"),
      leaseMs: parsePositiveInteger(paymentEffectsLeaseMs, "PAYMENT_EFFECTS_LEASE_MS"),
      maxAttempts: parsePositiveInteger(paymentEffectsMaxAttempts, "PAYMENT_EFFECTS_MAX_ATTEMPTS"),
      retryBaseMs: parsePositiveInteger(paymentEffectsRetryBaseMs, "PAYMENT_EFFECTS_RETRY_BASE_MS"),
    },
    frontendUrl,
    apiPublicUrl,
    mercadoPago,
    webhooks: {
      stripe: {
        signingSecret: stripeWebhookSigningSecret,
        toleranceSeconds: parsePositiveInteger(
          stripeWebhookToleranceSeconds,
          "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
        ),
      },
    },
    security: {
      publicOrderTokenSecret,
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
    supabase: {
      url: parseUrl(supabaseUrl, "SUPABASE_URL"),
      serviceRoleKey: supabaseServiceRoleKey,
      jwtSecret: supabaseJwtSecret,
    },
    r2,
  };
}

export function getConfig(): AppConfig {
  return createConfig(process.env);
}
