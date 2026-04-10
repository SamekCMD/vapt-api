import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import type { AppConfig } from "../lib/config.js";

export async function registerCors(app: FastifyInstance, config: AppConfig) {
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new AppError(500, "internal_error", "Origin not allowed"), false);
    },
  });
}
