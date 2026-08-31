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
  supabase: {
    url: URL;
    serviceRoleKey: string;
    jwtSecret: string;
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
    supabase: {
      url: parseUrl(supabaseUrl, "SUPABASE_URL"),
      serviceRoleKey: supabaseServiceRoleKey,
      jwtSecret: supabaseJwtSecret,
    },
  };
}

export function getConfig(): AppConfig {
  return createConfig(process.env);
}
