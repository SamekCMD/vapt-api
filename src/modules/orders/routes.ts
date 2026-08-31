import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { validateWithSchema } from "../../lib/validation.js";
import { createOrderRepository, type OrderRepository } from "./repository.js";
import {
  createOrderBodySchema,
  createOrderHeadersSchema,
  publicOrderHeadersSchema,
  publicOrderParamsSchema,
} from "./schemas.js";
import { createOrderService } from "./service.js";

export async function registerOrderRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: OrderRepository = createOrderRepository(createSupabaseAdminClient(config)),
) {
  const service = createOrderService(repository, config.supabase.jwtSecret);

  app.post(
    "/public/orders",
    { config: { rateLimitGroup: "orders" } },
    async (request, reply) => {
      const body = validateWithSchema(createOrderBodySchema, request.body);
      const headers = validateWithSchema(createOrderHeadersSchema, request.headers);
      const order = await service.createPublicOrder(body, headers["idempotency-key"]);
      reply.status(order.idempotentReplay ? 200 : 201);
      return order;
    },
  );

  app.get(
    "/public/orders/:orderId",
    { config: { rateLimitGroup: "orders" } },
    async (request) => {
      const params = validateWithSchema(publicOrderParamsSchema, request.params);
      const headers = validateWithSchema(publicOrderHeadersSchema, request.headers);
      return service.getPublicOrder(params.orderId, headers["x-vapt-order-token"]);
    },
  );
}
