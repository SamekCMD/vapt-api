import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { actorFromAuth,requireAuth } from "../../plugins/auth.js";
import { restaurantParamsSchema } from '../restaurants/schemas.js';
import type { KitchenRepository } from "./repository.js";
import {
  kitchenOrderParamsSchema,
  scopedKitchenOrderParamsSchema,
  updateKitchenOrderStatusBodySchema,
} from "./schemas.js";
import { createKitchenService } from "./service.js";

export async function registerKitchenRoutes(
  app: FastifyInstance,
  repository: KitchenRepository,
) {
  const service = createKitchenService(repository);
  const protectedOptions = {
    config: { rateLimitGroup: "auth" as const },
    preHandler: async (
      request: Parameters<typeof requireAuth>[0],
      reply: Parameters<typeof requireAuth>[1],
    ) => requireAuth(request, reply, app.authSessionResolver),
  };

  app.get(
    "/restaurants/me/kitchen/orders",
    protectedOptions,
    async (request) => service.listActiveOwnedOrders(request.auth!.userId),
  );

  app.patch(
    "/restaurants/me/kitchen/orders/:orderId/status",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(kitchenOrderParamsSchema, request.params);
      const body = validateWithSchema(updateKitchenOrderStatusBodySchema, request.body);
      return service.updateOwnedOrderStatus(request.auth!.userId, params.orderId, body.status,actorFromAuth(request.auth!));
    },
  );

  app.get('/restaurants/:restaurantId/kitchen/orders',protectedOptions,async request=>{
    const { restaurantId }=validateWithSchema(restaurantParamsSchema,request.params);
    return service.listActiveOrders({ userId:request.auth!.userId,restaurantId });
  });
  app.patch('/restaurants/:restaurantId/kitchen/orders/:orderId/status',protectedOptions,async request=>{
    const { restaurantId,orderId }=validateWithSchema(scopedKitchenOrderParamsSchema,request.params);
    const body=validateWithSchema(updateKitchenOrderStatusBodySchema,request.body);
    return service.updateOrderStatus({ ...actorFromAuth(request.auth!),restaurantId },orderId,body.status);
  });
}
