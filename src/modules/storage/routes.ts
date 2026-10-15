import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import {
  menuImageParamsSchema,
  prepareMenuImageUploadBodySchema,
} from "./schemas.js";
import type { MenuImageService } from "./service.js";

export async function registerMenuImageRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: MenuImageService,
) {
  const protectedOptions = {
    config: { rateLimitGroup: "storage" as const },
    preHandler: async (request: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) =>
      requireAuth(request, reply, app.authSessionResolver),
  };

  app.post(
    "/restaurants/:restaurantId/menu-items/:itemId/image/upload",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(menuImageParamsSchema, request.params);
      const body = validateWithSchema(prepareMenuImageUploadBodySchema, request.body);
      return service.prepareUpload({
        userId: request.auth!.userId,
        ...params,
        ...body,
      });
    },
  );

  app.delete(
    "/restaurants/:restaurantId/menu-items/:itemId/image",
    protectedOptions,
    async (request, reply) => {
      const params = validateWithSchema(menuImageParamsSchema, request.params);
      await service.delete({
        userId: request.auth!.userId,
        ...params,
      });
      reply.status(204).send();
    },
  );
}
