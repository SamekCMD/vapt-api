import { Hono } from "hono";

import type { WorkerBindings } from "./environment.js";
import { installWorkerHttpPolicy } from "./http.js";
import type { WorkerServicesFactory } from "./services.js";
import type { ApiServices } from "../composition/api-services.js";
import type { AuthContext } from "../plugins/auth.js";
import { registerWorkerAuthRoutes } from "./routes/auth.js";

export type WorkerHonoEnv = {
  Bindings: WorkerBindings;
  Variables: { getServices: () => Promise<ApiServices>; auth: AuthContext };
};

export function createWorkerApp(
  createServices?: WorkerServicesFactory,
  options: { authRateLimit?: boolean } = {},
): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>();
  installWorkerHttpPolicy(app, createServices);
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (createServices) {
    registerWorkerAuthRoutes(app, { rateLimit: options.authRateLimit });
    app.get("/health/ready", async (context) => {
      const services = await createServices(context.env, context.executionCtx);
      return context.json({
        status: "ready",
        paymentEffects: services.payments.reconciliation.snapshot(),
      });
    });
  }
  return app;
}
