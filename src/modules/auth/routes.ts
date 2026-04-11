import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { createRestaurantAccessChecker } from "../../lib/permissions.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import { restaurantAccessParamsSchema } from "./schemas.js";

type OwnershipLookup = (input: { userId: string; restaurantId: string }) => Promise<boolean>;

const defaultOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ownershipLookup: OwnershipLookup = defaultOwnershipLookup,
) {
  const assertRestaurantAccess = createRestaurantAccessChecker(ownershipLookup);

  app.get(
    "/auth/me",
    {
      config: {
        rateLimitGroup: "auth",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
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
      preHandler: async (request, reply) => requireAuth(request, reply, config),
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
