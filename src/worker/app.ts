import { Hono } from "hono";

import type { WorkerBindings } from "./environment.js";
import { installWorkerHttpPolicy } from "./http.js";
import type { WorkerServicesFactory } from "./services.js";
import type { ApiServices } from "../composition/api-services.js";
import type { AuthContext } from "../plugins/auth.js";
import { registerWorkerAuthRoutes } from "./routes/auth.js";
import { registerWorkerPublicRoutes } from "./routes/public.js";
import { registerWorkerRestaurantRoutes } from "./routes/restaurant.js";
import { registerWorkerStripeRoutes } from "./routes/stripe.js";
import { registerWorkerMercadoPagoRoutes } from "./routes/mercado-pago.js";

export type WorkerHonoEnv = {
  Bindings: WorkerBindings;
  Variables: { getServices: () => Promise<ApiServices>; auth: AuthContext };
};

export function createWorkerApp(
  createServices?: WorkerServicesFactory,
  options: { authRateLimit?: boolean; publicRateLimit?: boolean; privateRateLimit?: boolean; stripeRateLimit?: boolean; paymentRateLimit?: boolean } = {},
): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>();
  installWorkerHttpPolicy(app, createServices);
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (createServices) {
    registerWorkerAuthRoutes(app, { rateLimit: options.authRateLimit });
    registerWorkerPublicRoutes(app, { rateLimit: options.publicRateLimit });
    registerWorkerRestaurantRoutes(app, { rateLimit: options.privateRateLimit });
    registerWorkerStripeRoutes(app, { rateLimit: options.stripeRateLimit });
    registerWorkerMercadoPagoRoutes(app, { rateLimit: options.paymentRateLimit });
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
