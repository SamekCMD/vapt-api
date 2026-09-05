import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import {
  createRestaurantAccessChecker,
  createSupabaseMembershipLookup,
  testMembershipLookup,
  type MembershipLookup,
} from "../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import { restaurantAccessParamsSchema } from "./schemas.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  membershipLookup?: MembershipLookup,
) {
  const resolvedMembershipLookup =
    membershipLookup ??
    (config.nodeEnv === "test"
      ? testMembershipLookup
      : createSupabaseMembershipLookup(createSupabaseAdminClient(config) as never));
  const assertRestaurantAccess = createRestaurantAccessChecker(resolvedMembershipLookup);

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

      await assertRestaurantAccess({
        userId,
        restaurantId,
        capability: "restaurant.read",
      });

      return {
        allowed: true,
        restaurantId,
        userId,
      };
    },
  );
}
