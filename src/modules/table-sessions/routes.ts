import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import { AppError } from "../../lib/errors.js";
import type { OrderService } from "../orders/service.js";
import type { TableSessionRepository } from "./repository.js";
import {
  tableSessionParamsSchema,
  requestCheckTableSessionBodySchema,
  transferTableSessionBodySchema,
} from "./schemas.js";
import { createTableSessionService } from "./service.js";

export async function registerTableSessionRoutes(
  app: FastifyInstance,
  repository: TableSessionRepository,
  publicOrders?: Pick<OrderService, "getPublicOrder">,
) {
  const service = createTableSessionService(repository);
  const protectedOptions = {
    config: { rateLimitGroup: "auth" as const },
    preHandler: async (
      request: Parameters<typeof requireAuth>[0],
      reply: Parameters<typeof requireAuth>[1],
    ) => requireAuth(request, reply, app.authSessionResolver),
  };

  app.get(
    "/restaurants/me/table-sessions",
    protectedOptions,
    async (request) => service.listActiveOwnedSessions(request.auth!.userId),
  );

  app.get(
    "/restaurants/me/table-sessions/:sessionId",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(tableSessionParamsSchema, request.params);
      return service.getOwnedSession(request.auth!.userId, params.sessionId);
    },
  );

  app.post(
    "/restaurants/me/table-sessions/:sessionId/close",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(tableSessionParamsSchema, request.params);
      return service.closeOwnedSession(request.auth!.userId, params.sessionId);
    },
  );

  app.post(
    "/restaurants/me/table-sessions/:sessionId/transfer",
    protectedOptions,
    async (request) => {
      const params = validateWithSchema(tableSessionParamsSchema, request.params);
      const body = validateWithSchema(transferTableSessionBodySchema, request.body);
      return service.transferOwnedSession(
        request.auth!.userId,
        params.sessionId,
        body.tableNumber,
      );
    },
  );

  if (publicOrders) {
    app.post(
      "/public/table-sessions/:sessionId/request-check",
      { config: { rateLimitGroup: "orders" } },
      async (request) => {
        const params = validateWithSchema(tableSessionParamsSchema, request.params);
        const body = validateWithSchema(requestCheckTableSessionBodySchema, request.body);
        let order;
        try {
          order = await publicOrders.getPublicOrder(body.publicOrderId, body.publicOrderToken);
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 404) {
            throw new AppError(401, "invalid_order_token", "Invalid order token");
          }
          throw error;
        }
        return service.requestPublicCheck(params.sessionId, order);
      },
    );
  }
}
