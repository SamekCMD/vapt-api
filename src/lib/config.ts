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

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = requireValue(env, "NODE_ENV");
  const port = requireValue(env, "PORT");
  const host = requireValue(env, "HOST");
  const corsOrigins = requireValue(env, "CORS_ORIGINS");
  const logLevel = requireValue(env, "LOG_LEVEL");

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
  };
}

export function getConfig(): AppConfig {
  return createConfig(process.env);
}
