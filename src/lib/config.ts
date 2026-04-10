const validNodeEnvs = new Set(["development", "test", "production"]);
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
      webhookSetup: string;
      admin: string;
    };
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

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = getValueOrDefault(env, "NODE_ENV", "production");
  const port = getValueOrDefault(env, "PORT", "3000");
  const host = getValueOrDefault(env, "HOST", "0.0.0.0");
  const corsOrigins = requireValue(env, "CORS_ORIGINS");
  const logLevel = getValueOrDefault(env, "LOG_LEVEL", "info");
  const n8nBaseUrl = requireValue(env, "N8N_BASE_URL");
  const n8nTimeoutMs = requireValue(env, "N8N_TIMEOUT_MS");
  const appSecret = requireValue(env, "VAPT_APP_ENDPOINT_SECRET");
  const webhookSetupSecret = requireValue(env, "VAPT_WEBHOOK_SETUP_SECRET");
  const adminSecret = requireValue(env, "VAPT_ADMIN_ENDPOINT_SECRET");
  const stripeWebhookSigningSecret = requireValue(env, "STRIPE_WEBHOOK_SIGNING_SECRET");
  const stripeWebhookToleranceSeconds = getValueOrDefault(
    env,
    "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
    "300",
  );
  const supabaseUrl = requireValue(env, "SUPABASE_URL");
  const supabaseServiceRoleKey = requireValue(env, "SUPABASE_SERVICE_ROLE_KEY");
  const supabaseJwtSecret = requireValue(env, "SUPABASE_JWT_SECRET");

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
        webhookSetup: webhookSetupSecret,
        admin: adminSecret,
      },
    },
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
