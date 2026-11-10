import type { FastifyInstance } from "fastify";
import { validateWithSchema } from "../../lib/validation.js";
import type { CatalogRepository } from "./repository.js";
import { catalogParamsSchema } from "./schemas.js";
import { createCatalogService } from "./service.js";

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
