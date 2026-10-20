import type { WithAuthorizedMenuItem } from './repository.js';
import type { RestaurantWriteScope } from '../tenancy/contracts.js';

export type MenuImageContentType = "image/jpeg" | "image/png" | "image/webp";

export type MenuImageGateway = {
  createUploadUrl(input: {
    objectKey: string;
    contentType: MenuImageContentType;
    contentLength: number;
    expiresInSeconds: number;
    ifMatch?: string;
  }): Promise<string>;
  deleteObject(input: { objectKey: string }): Promise<void>;
};

type MenuImageInput = RestaurantWriteScope & { itemId:string };

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
  withAuthorizedItem: WithAuthorizedMenuItem;
  gateway: MenuImageGateway;
  publicBaseUrl: URL;
  uploadUrlTtlSeconds: number;
}): MenuImageService {
  return {
    async prepareUpload(operation) {
      return input.withAuthorizedItem(operation,async()=>{
      const objectKey = objectKeyFor(operation.restaurantId,operation.itemId);
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
      });
    },

    async delete(operation) {
      return input.withAuthorizedItem(operation,async()=>{
      const objectKey = objectKeyFor(operation.restaurantId,operation.itemId);
      await input.gateway.deleteObject({ objectKey });
      });
    },
  };
}
