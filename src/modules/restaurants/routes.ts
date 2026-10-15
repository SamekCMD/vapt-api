import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import type { RestaurantRepository } from "./repository.js";
import {
  onboardingBodySchema,
  updateOwnedRestaurantBodySchema,
} from "./schemas.js";
import { createRestaurantService } from "./service.js";

export async function registerRestaurantRoutes(
  app: FastifyInstance,
  repository: RestaurantRepository,
) {
  const service = createRestaurantService(repository);
  const authenticated = async (request: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) =>
    requireAuth(request, reply, app.authSessionResolver);

  app.post(
    "/onboarding",
    { config: { rateLimitGroup: "auth" }, preHandler: authenticated },
    async (request, reply) => {
      const body = validateWithSchema(onboardingBodySchema, request.body);
      const restaurant = await service.createOwnedRestaurant(request.auth!.userId, body);
      reply.status(201);
      return restaurant;
    },
  );

  app.get(
    "/restaurants/me",
    { config: { rateLimitGroup: "auth" }, preHandler: authenticated },
    async (request) => service.getOwnedRestaurant(request.auth!.userId),
  );

  app.patch(
    "/restaurants/me",
    { config: { rateLimitGroup: "auth" }, preHandler: authenticated },
    async (request) => {
      const body = validateWithSchema(updateOwnedRestaurantBodySchema, request.body);
      return service.updateOwnedRestaurant(request.auth!.userId, body);
    },
  );
}
