import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import type { TableSessionRepository } from "./repository.js";
import {
  tableSessionParamsSchema,
  transferTableSessionBodySchema,
} from "./schemas.js";
import { createTableSessionService } from "./service.js";

export async function registerTableSessionRoutes(
  app: FastifyInstance,
  repository: TableSessionRepository,
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
}
