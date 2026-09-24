import type { RestaurantAccessChecker } from "../../lib/permissions.js";
import { AppError } from "../../lib/errors.js";
import type { MenuItemExists } from "./repository.js";

export type MenuImageContentType = "image/jpeg" | "image/png" | "image/webp";

export type MenuImageGateway = {
  createUploadUrl(input: {
    objectKey: string;
    contentType: MenuImageContentType;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;
  deleteObject(input: { objectKey: string }): Promise<void>;
};

type MenuImageInput = {
  userId: string;
  restaurantId: string;
  itemId: string;
};

type PrepareUploadInput = MenuImageInput & {
  contentType: MenuImageContentType;
  contentLength: number;
};

export type MenuImageService = {
  prepareUpload(input: PrepareUploadInput): Promise<{
    method: "PUT";
    uploadUrl: string;
    publicUrl: string;
    objectKey: string;
    headers: { "Content-Type": MenuImageContentType };
    expiresInSeconds: number;
  }>;
  delete(input: MenuImageInput): Promise<void>;
};

function objectKeyFor(restaurantId: string, itemId: string): string {
  return `${restaurantId}/${itemId}`;
}

function publicUrlFor(baseUrl: URL, objectKey: string): string {
  const normalizedBase = new URL(baseUrl.toString());
  if (!normalizedBase.pathname.endsWith("/")) normalizedBase.pathname += "/";
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return new URL(encodedKey, normalizedBase).toString();
}

export function createMenuImageService(input: {
  assertRestaurantAccess: RestaurantAccessChecker;
  menuItemExists: MenuItemExists;
  gateway: MenuImageGateway;
  publicBaseUrl: URL;
  uploadUrlTtlSeconds: number;
}): MenuImageService {
  async function authorize(operation: MenuImageInput): Promise<string> {
    await input.assertRestaurantAccess({
      userId: operation.userId,
      restaurantId: operation.restaurantId,
    });

    const exists = await input.menuItemExists({
      restaurantId: operation.restaurantId,
      itemId: operation.itemId,
    });
    if (!exists) {
      throw new AppError(404, "menu_item_not_found", "Menu item not found");
    }

    return objectKeyFor(operation.restaurantId, operation.itemId);
  }

  return {
    async prepareUpload(operation) {
      const objectKey = await authorize(operation);
      const uploadUrl = await input.gateway.createUploadUrl({
        objectKey,
        contentType: operation.contentType,
        contentLength: operation.contentLength,
        expiresInSeconds: input.uploadUrlTtlSeconds,
      });

      return {
        method: "PUT",
        uploadUrl,
        publicUrl: publicUrlFor(input.publicBaseUrl, objectKey),
        objectKey,
        headers: { "Content-Type": operation.contentType },
        expiresInSeconds: input.uploadUrlTtlSeconds,
      };
    },

    async delete(operation) {
      const objectKey = await authorize(operation);
      await input.gateway.deleteObject({ objectKey });
    },
  };
}
