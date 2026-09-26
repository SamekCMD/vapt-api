import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { validateWithSchema } from "../../lib/validation.js";
import type { CatalogRepository } from "./repository.js";
import { createCatalogService } from "./service.js";

const catalogParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
}).strict();

export async function registerCatalogRoutes(
  app: FastifyInstance,
  repository: CatalogRepository,
) {
  const service = createCatalogService(repository);

  app.get(
    "/public/restaurants/:slug/catalog",
    { config: { rateLimitGroup: "public" } },
    async (request) => {
      const params = validateWithSchema(catalogParamsSchema, request.params);
      return service.getPublishedCatalog(params.slug);
    },
  );
}
