import Fastify from "fastify";

import type { AppConfig } from "./lib/config.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerCors } from "./plugins/cors.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { createLoggerConfig } from "./plugins/logger.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: createLoggerConfig(config),
  });

  registerErrorHandler(app);
  await registerCors(app, config);
  await registerHealthRoutes(app);

  return app;
}
