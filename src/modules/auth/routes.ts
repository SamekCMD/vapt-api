import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import {
  createRestaurantAccessChecker,
  testOwnershipLookup,
  type OwnershipLookup,
} from "../../lib/permissions.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import { restaurantAccessParamsSchema } from "./schemas.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ownershipLookup?: OwnershipLookup,
) {
  const resolvedOwnershipLookup =
    ownershipLookup ??
    (config.nodeEnv === "test"
      ? testOwnershipLookup
      : (() => {
          throw new AppError(500, "internal_error", "Ownership lookup is not configured");
        })());
  const assertRestaurantAccess = createRestaurantAccessChecker(resolvedOwnershipLookup);

  app.get(
    "/auth/me",
    {
      config: {
        rateLimitGroup: "auth",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      return request.auth;
    },
  );

  app.get(
    "/auth/restaurants/:restaurantId/access",
    {
      config: {
        rateLimitGroup: "auth",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const params = validateWithSchema(restaurantAccessParamsSchema, request.params);
      const restaurantId = params.restaurantId;
      const userId = request.auth!.userId;

      await assertRestaurantAccess({ userId, restaurantId });

      return {
        allowed: true,
        restaurantId,
        userId,
      };
    },
  );
}
