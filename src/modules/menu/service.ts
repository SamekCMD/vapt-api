import { AppError } from "../../lib/errors.js";
import type { MenuRepository } from "./repository.js";
import type { CreateMenuItemBody, UpdateMenuItemBody } from "./schemas.js";

type MenuServiceOptions = {
  publicBaseUrl: URL | null;
};

function notFound(): AppError {
  return new AppError(404, "menu_item_not_found", "Menu item not found");
}

function assertPublicImageUrl(imageUrl: string | null | undefined, publicBaseUrl: URL | null): void {
  if (imageUrl === undefined || imageUrl === null) return;
  if (!publicBaseUrl) {
    throw new AppError(400, "invalid_image_url", "Menu image URL is not allowed");
  }

  const candidate = new URL(imageUrl);
  const base = new URL(publicBaseUrl.toString());
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (
    candidate.origin !== base.origin
    || !candidate.pathname.startsWith(basePath)
    || candidate.username !== ""
    || candidate.password !== ""
    || candidate.search !== ""
    || candidate.hash !== ""
  ) {
    throw new AppError(400, "invalid_image_url", "Menu image URL is not allowed");
  }
}

export function createMenuService(repository: MenuRepository, options: MenuServiceOptions) {
  return {
    listOwnedMenuItems(userId: string) {
      return repository.listOwnedMenuItems(userId);
    },

    async createOwnedMenuItem(userId: string, input: CreateMenuItemBody) {
      assertPublicImageUrl(input.imageUrl, options.publicBaseUrl);
      const item = await repository.createOwnedMenuItem(userId, input);
      if (!item) throw new AppError(404, "restaurant_not_found", "Restaurant not found");
      return item;
    },

    async updateOwnedMenuItem(userId: string, itemId: string, patch: UpdateMenuItemBody) {
      assertPublicImageUrl(patch.imageUrl, options.publicBaseUrl);
      const item = await repository.updateOwnedMenuItem(userId, itemId, patch);
      if (!item) throw notFound();
      return item;
    },

    async deleteOwnedMenuItem(userId: string, itemId: string) {
      if (!await repository.deleteOwnedMenuItem(userId, itemId)) throw notFound();
    },
  };
}
