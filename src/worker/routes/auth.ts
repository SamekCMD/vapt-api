import type { Hono, MiddlewareHandler } from "hono";

import { createRestaurantAccessChecker } from "../../lib/permissions.js";
import { validateWithSchema } from "../../lib/validation.js";
import { restaurantAccessParamsSchema } from "../../modules/auth/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { requireWorkerAuth, workerRateLimit } from "../http.js";

export function registerWorkerAuthRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const rate: MiddlewareHandler<WorkerHonoEnv> = options.rateLimit === false
    ? async (_context, next) => next()
    : workerRateLimit("auth");

  app.on(["GET", "POST"], "/api/auth/*", rate, async (context) => {
    const services = await context.get("getServices")();
    return services.authRuntime.handler(context.req.raw);
  });
  app.get("/auth/me", rate, async (context) => context.json(await requireWorkerAuth(context)));
  app.get("/auth/restaurants/:restaurantId/access", rate, async (context) => {
    const auth = await requireWorkerAuth(context);
    const params = validateWithSchema(restaurantAccessParamsSchema, context.req.param());
    const services = await context.get("getServices")();
    await createRestaurantAccessChecker(services.ownershipLookup)({
      userId: auth.userId,
      restaurantId: params.restaurantId,
    });
    return context.json({ allowed: true, restaurantId: params.restaurantId, userId: auth.userId });
  });
}
