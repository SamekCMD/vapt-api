import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import type { OverviewRepository } from "./repository.js";
import { overviewQuerySchema } from "./schemas.js";
import { createOverviewService } from "./service.js";

export async function registerOverviewRoutes(
  app: FastifyInstance,
  repository: OverviewRepository,
  now?: () => Date,
) {
  const service = createOverviewService(repository, now);
  const authenticated = async (
    request: Parameters<typeof requireAuth>[0],
    reply: Parameters<typeof requireAuth>[1],
  ) => requireAuth(request, reply, app.authSessionResolver);

  app.get(
    "/restaurants/me/overview",
    { config: { rateLimitGroup: "auth" }, preHandler: authenticated },
    async (request) => {
      const query = validateWithSchema(overviewQuerySchema, request.query);
      return service.getOwnedOverview(request.auth!.userId, query.period);
    },
  );
}
