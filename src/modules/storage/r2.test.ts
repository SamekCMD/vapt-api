import assert from "node:assert/strict";
import test from "node:test";

import { createR2MenuImageGateway } from "./r2.js";

test("R2 gateway creates a short-lived PUT URL without exposing the secret", async () => {
  const gateway = createR2MenuImageGateway({
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "test-access-key",
    secretAccessKey: "do-not-expose-this-secret",
    bucketName: "vapt-assets-preview",
    publicBaseUrl: new URL("https://assets-preview.vapt.test"),
    uploadUrlTtlSeconds: 300,
  });

  const signed = await gateway.createUploadUrl({
    objectKey: "10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002",
    contentType: "image/jpeg",
    contentLength: 123,
    expiresInSeconds: 300,
  });
  const url = new URL(signed);

  assert.match(url.hostname, /\.r2\.cloudflarestorage\.com$/);
  assert.match(url.pathname, /10000000-0000-4000-8000-000000000001\/20000000-0000-4000-8000-000000000002$/);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "content-length;content-type;host",
  );
  assert.equal(url.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(url.searchParams.has("x-amz-sdk-checksum-algorithm"), false);
  assert.equal(signed.includes("do-not-expose-this-secret"), false);
});
