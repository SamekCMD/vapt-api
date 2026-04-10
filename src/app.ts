import Fastify from "fastify";

import type { AppConfig } from "./lib/config.js";
import { registerAsaasBillingRoutes } from "./modules/billing/asaas/routes.js";
import { registerStripeBillingRoutes } from "./modules/billing/stripe/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerWebhookRoutes } from "./modules/webhooks/routes.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuthDecorator } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { createLoggerConfig } from "./plugins/logger.js";
import { registerRawBody } from "./plugins/raw-body.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: createLoggerConfig(config),
  });

  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerRawBody(app);
  await registerCors(app, config);
  await registerHealthRoutes(app);
  await registerAuthRoutes(app, config);
  await registerStripeBillingRoutes(app, config);
  await registerAsaasBillingRoutes(app, config);
  await registerWebhookRoutes(app, config);

  return app;
}
