import type { FastifyServerOptions } from "fastify";

import type { AppConfig } from "../lib/config.js";

export function createLoggerConfig(config: AppConfig): FastifyServerOptions["logger"] {
  if (config.nodeEnv === "test") {
    return false;
  }

  return {
    level: config.logLevel,
    transport:
      config.nodeEnv === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  };
}
