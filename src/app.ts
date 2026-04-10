import Fastify from "fastify";

import type { AppConfig } from "./lib/config.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuthDecorator } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { createLoggerConfig } from "./plugins/logger.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: createLoggerConfig(config),
  });

  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerCors(app, config);
  await registerHealthRoutes(app);
  await registerAuthRoutes(app, config);

  return app;
}
