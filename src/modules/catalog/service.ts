import { AppError } from "../../lib/errors.js";
import type { CatalogRepository } from "./repository.js";

export function createCatalogService(repository: CatalogRepository) {
  return {
    async getPublishedCatalog(slug: string) {
      const catalog = await repository.findPublishedBySlug(slug);
      if (!catalog) {
        throw new AppError(404, "not_found", "Restaurant not found");
      }
      return catalog;
    },
  };
}
