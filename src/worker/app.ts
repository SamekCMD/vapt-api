import { Hono } from "hono";

import type { WorkerBindings } from "./environment.js";
import type { WorkerServicesFactory } from "./services.js";

export type WorkerHonoEnv = { Bindings: WorkerBindings };

export function createWorkerApp(createServices?: WorkerServicesFactory): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>();
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (createServices) {
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
