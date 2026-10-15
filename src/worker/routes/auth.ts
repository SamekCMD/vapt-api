import type { Hono, MiddlewareHandler } from "hono";

import { createRestaurantAccessChecker } from "../../lib/permissions.js";
import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import { restaurantAccessParamsSchema } from "../../modules/auth/schemas.js";
import type { WorkerHonoEnv } from "../app.js";
import { readWorkerBody, requireWorkerAuth, workerRateLimit } from "../http.js";

export function registerWorkerAuthRoutes(
  app: Hono<WorkerHonoEnv>,
  options: { rateLimit?: boolean } = {},
): void {
  const rate: MiddlewareHandler<WorkerHonoEnv> = options.rateLimit === false
    ? async (_context, next) => next()
    : workerRateLimit("auth");

  app.on(["GET", "POST"], "/api/auth/*", rate, async (context) => {
    let request = context.req.raw;
    // Bound POST bytes before auth/SQL/provider initialization, including
    // chunked bodies. GET keeps its original body-free request.
    if (request.method === "POST") {
      const hasBody = request.body !== null;
      const body = await readWorkerBody(request, new AppError(413, "payload_too_large", "Payload too large"));
      // Preserve body-free logout and absent Content-Type. A string body would
      // silently add text/plain, which Better Auth correctly rejects.
      if (hasBody) request = new Request(request, { body: new TextEncoder().encode(body) });
    }
    const services = await context.get("getServices")();
    return services.authRuntime.handler(request);
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
