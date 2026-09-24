import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import type { AppConfig } from "../lib/config.js";

export function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin);
}

export async function registerCors(app: FastifyInstance, config: AppConfig) {
  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isAllowedOrigin(origin, config.corsOrigins)) {
        callback(null, true);
        return;
      }

      callback(new AppError(500, "internal_error", "Origin not allowed"), false);
    },
  });
}
