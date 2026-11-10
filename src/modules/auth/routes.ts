import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import type {RestaurantAuthorizer} from '../../lib/permissions.js';
import { validateWithSchema } from "../../lib/validation.js";
import { authIdentityDto, requireAuth } from "../../plugins/auth.js";
import { restaurantAccessParamsSchema } from "./schemas.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authorizeRestaurant:RestaurantAuthorizer,
) {
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
      return authIdentityDto(request.auth!);
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

      await authorizeRestaurant({ userId, restaurantId },'restaurant.read');

      return {
        allowed: true,
        restaurantId,
        userId,
      };
    },
  );
}
