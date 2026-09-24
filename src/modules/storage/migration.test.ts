import assert from "node:assert/strict";
import test from "node:test";

import { classifyStorageObject, normalizeEtag } from "./migration.js";

const source = {
  key: "restaurant/item",
  size: 123,
  contentType: "image/jpeg",
  etag: '"abc123"',
  updatedAt: "2026-09-24T12:00:00.000Z",
};

test("storage migration classifies missing and changed targets for copying", () => {
  assert.equal(classifyStorageObject(source, null), "missing");
  assert.equal(classifyStorageObject(source, {
    size: 122,
    contentType: "image/jpeg",
    metadata: { "source-etag": "abc123" },
  }), "needs-copy");
  assert.equal(classifyStorageObject(source, {
    size: 123,
    contentType: "image/png",
    metadata: { "source-etag": "abc123" },
  }), "needs-copy");
});

test("storage migration only verifies objects tied to the same source etag", () => {
  assert.equal(classifyStorageObject(source, {
    size: 123,
    contentType: "image/jpeg",
    metadata: {},
  }), "needs-copy");
  assert.equal(classifyStorageObject(source, {
    size: 123,
    contentType: "image/jpeg",
    metadata: { "source-etag": "abc123" },
  }), "verified");
  assert.equal(normalizeEtag('"abc123"'), "abc123");
});

test("storage migration can verify legacy objects whose source has no etag", () => {
  const sourceWithoutEtag = { ...source, etag: null };

  assert.equal(classifyStorageObject(sourceWithoutEtag, {
    size: 123,
    contentType: "image/jpeg",
    metadata: {
      "source-key": source.key,
      "source-updated-at": source.updatedAt!,
    },
  }), "verified");
});
