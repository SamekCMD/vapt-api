import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerMenuImageGateway } from "./r2-worker.js";

const signing = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "synthetic-preview-access",
  secretAccessKey: "synthetic-preview-secret",
  bucketName: "vapt-assets-preview",
  publicBaseUrl: new URL("https://assets-preview.vapt.test"),
  uploadUrlTtlSeconds: 60,
};
const upload = {
  objectKey: "10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002",
  contentType: "image/png" as const,
  contentLength: 123,
  expiresInSeconds: 60,
};

test("native Worker R2 deletion does not require initializing upload credentials", async () => {
  const deleted: string[] = [];
  const gateway = createWorkerMenuImageGateway({
    ...signing,
    get accessKeyId(): string { throw new Error("Upload credentials must not be read for native deletion"); },
  }, {
    async delete(key) { deleted.push(key); },
  });

  await gateway.deleteObject({ objectKey: upload.objectKey });

  assert.deepEqual(deleted, ["10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002"]);
});

test("concurrent Worker R2 uploads initialize credentials once and retain signed PUT constraints", async () => {
  let credentialReads = 0;
  const gateway = createWorkerMenuImageGateway({
    ...signing,
    get accessKeyId() { credentialReads++; return "synthetic-preview-access"; },
  }, { async delete() {} });

  assert.equal(credentialReads, 0);
  const urls = await Promise.all([
    gateway.createUploadUrl(upload),
    gateway.createUploadUrl({ ...upload, objectKey: "10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000003" }),
  ]);

  assert.equal(credentialReads, 1);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.hostname, "vapt-assets-preview.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    assert.match(url.pathname, /^\/10000000-0000-4000-8000-000000000001\//);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[a-f0-9]{64}$/);
    assert.equal(value.includes("synthetic-preview-secret"), false);
  }
  assert.notEqual(new URL(urls[0]!).pathname, new URL(urls[1]!).pathname);
});

test("Worker R2 gateways do not reuse signer credentials across environments", async () => {
  const preview = createWorkerMenuImageGateway(signing, { async delete() {} });
  const production = createWorkerMenuImageGateway({
    ...signing,
    accountId: "abcdef0123456789abcdef0123456789",
    accessKeyId: "synthetic-production-access",
    secretAccessKey: "synthetic-production-secret",
    bucketName: "vapt-assets-production",
  }, { async delete() {} });

  const [previewUrl, productionUrl] = await Promise.all([
    preview.createUploadUrl(upload), production.createUploadUrl(upload),
  ]);
  assert.match(new URL(previewUrl).searchParams.get("X-Amz-Credential") ?? "", /^synthetic-preview-access\//);
  assert.match(new URL(productionUrl).searchParams.get("X-Amz-Credential") ?? "", /^synthetic-production-access\//);
  assert.equal(new URL(productionUrl).hostname, "vapt-assets-production.abcdef0123456789abcdef0123456789.r2.cloudflarestorage.com");
  assert.equal(new URL(productionUrl).pathname, "/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002");
});
