import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { actorFromAuth, requireAuth } from "../../plugins/auth.js";
import type { MenuRepository } from "./repository.js";
import {
  createMenuItemBodySchema,
  menuItemParamsSchema,
  restaurantMenuParamsSchema,
  restaurantMenuItemParamsSchema,
  updateMenuItemBodySchema,
} from "./schemas.js";
import { createMenuService } from "./service.js";

export async function registerMenuRoutes(
  app: FastifyInstance,
  repository: MenuRepository,
  options: { publicBaseUrl: URL | null },
) {
  const service = createMenuService(repository, options);
  const protectedOptions = {
    config: { rateLimitGroup: "auth" as const },
    preHandler: async (
      request: Parameters<typeof requireAuth>[0],
      reply: Parameters<typeof requireAuth>[1],
    ) => requireAuth(request, reply, app.authSessionResolver),
  };

  app.get(
    "/restaurants/me/menu-items",
    protectedOptions,
    async (request) => service.listOwnedMenuItems(request.auth!.userId),
  );

  app.post(
    "/restaurants/me/menu-items",
    protectedOptions,
    async (request, reply) => {
      const body = validateWithSchema(createMenuItemBodySchema, request.body);
      const item = await service.createOwnedMenuItem(request.auth!.userId, body,actorFromAuth(request.auth!));
      reply.status(201);
      return item;
    },
  );

  app.patch(
    "/restaurants/me/menu-items/:itemId",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(menuItemParamsSchema, request.params);
      const body = validateWithSchema(updateMenuItemBodySchema, request.body);
      return service.updateOwnedMenuItem(request.auth!.userId, params.itemId, body,actorFromAuth(request.auth!));
    },
  );

  app.delete(
    "/restaurants/me/menu-items/:itemId",
    protectedOptions,
    async (request, reply) => {
      const params = validateWithSchema(menuItemParamsSchema, request.params);
      await service.deleteOwnedMenuItem(request.auth!.userId, params.itemId,actorFromAuth(request.auth!));
      reply.status(204).send();
    },
  );

  app.get('/restaurants/:restaurantId/menu-items',protectedOptions,async request=>{
    const { restaurantId }=validateWithSchema(restaurantMenuParamsSchema,request.params);
    return service.listMenuItems({ userId:request.auth!.userId,restaurantId });
  });
  app.post('/restaurants/:restaurantId/menu-items',protectedOptions,async(request,reply)=>{
    const { restaurantId }=validateWithSchema(restaurantMenuParamsSchema,request.params);
    const body=validateWithSchema(createMenuItemBodySchema,request.body);
    const item=await service.createMenuItem({ ...actorFromAuth(request.auth!),restaurantId },body);
    reply.status(201); return item;
  });
  app.patch('/restaurants/:restaurantId/menu-items/:itemId',protectedOptions,async request=>{
    const { restaurantId,itemId }=validateWithSchema(restaurantMenuItemParamsSchema,request.params);
    const body=validateWithSchema(updateMenuItemBodySchema,request.body);
    return service.updateMenuItem({ ...actorFromAuth(request.auth!),restaurantId },itemId,body);
  });
  app.delete('/restaurants/:restaurantId/menu-items/:itemId',protectedOptions,async(request,reply)=>{
    const { restaurantId,itemId }=validateWithSchema(restaurantMenuItemParamsSchema,request.params);
    await service.deleteMenuItem({ ...actorFromAuth(request.auth!),restaurantId },itemId);
    reply.status(204).send();
  });
}
