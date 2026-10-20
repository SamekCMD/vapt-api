import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../../lib/errors.js";
import { createMenuImageService } from "./service.js";

const actor={userId:"30000000-0000-4000-8000-000000000001",sessionId:"40000000-0000-4000-8000-000000000001",sessionExpiresAt:Date.now()+60_000};
const restaurantId = "10000000-0000-4000-8000-000000000001";
const itemId = "20000000-0000-4000-8000-000000000002";

test("menu image upload preserves the legacy object key and returns the canonical URL", async () => {
  const calls: unknown[] = [];
  const service = createMenuImageService({
    withAuthorizedItem:async(input,work)=>{ calls.push(["authorized",input]);return work(); },
    gateway: {
      async createUploadUrl(input) {
        calls.push(["sign", input]);
        return "https://signed.example.com/upload";
      },
      async deleteObject(input) {
        calls.push(["delete", input]);
      },
    },
    publicBaseUrl: new URL("https://assets.vapt.app.br"),
    uploadUrlTtlSeconds: 300,
  });

  const result = await service.prepareUpload({
    ...actor,
    restaurantId,
    itemId,
    contentType: "image/jpeg",
    contentLength: 1234,
  });

  assert.deepEqual(result, {
    method: "PUT",
    uploadUrl: "https://signed.example.com/upload",
    publicUrl: `https://assets.vapt.app.br/${restaurantId}/${itemId}`,
    objectKey: `${restaurantId}/${itemId}`,
    headers: { "Content-Type": "image/jpeg" },
    expiresInSeconds: 300,
  });
  assert.deepEqual(calls, [
    ["authorized", { ...actor, restaurantId, itemId,contentType:"image/jpeg",contentLength:1234 }],
    ["sign", {
      objectKey: `${restaurantId}/${itemId}`,
      contentType: "image/jpeg",
      contentLength: 1234,
      expiresInSeconds: 300,
    }],
  ]);
});

test("menu image operations reject an item outside the restaurant", async () => {
  let gatewayCalled = false;
  const service = createMenuImageService({
    withAuthorizedItem: async () => { throw new AppError(404,"menu_item_not_found","Menu item not found"); },
    gateway: {
      async createUploadUrl() {
        gatewayCalled = true;
        return "https://signed.example.com/upload";
      },
      async deleteObject() {
        gatewayCalled = true;
      },
    },
    publicBaseUrl: new URL("https://assets.vapt.app.br"),
    uploadUrlTtlSeconds: 300,
  });

  await assert.rejects(
    service.delete({ ...actor, restaurantId, itemId }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 404 &&
      error.code === "menu_item_not_found",
  );
  assert.equal(gatewayCalled, false);
});

test("menu image delete is authorized before removing the exact object key", async () => {
  const deleted: string[] = [];
  const service = createMenuImageService({
    withAuthorizedItem: async (_scope,work) => work(),
    gateway: {
      async createUploadUrl() {
        throw new Error("not used");
      },
      async deleteObject(input) {
        deleted.push(input.objectKey);
      },
    },
    publicBaseUrl: new URL("https://assets.vapt.app.br"),
    uploadUrlTtlSeconds: 300,
  });

  await service.delete({ ...actor, restaurantId, itemId });

  assert.deepEqual(deleted, [`${restaurantId}/${itemId}`]);
});
