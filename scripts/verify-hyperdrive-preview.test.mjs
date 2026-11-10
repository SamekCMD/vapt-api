import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPreviewIdentity,
  assertTransaction,
  assertCacheDisabledResource,
  safeSummary,
} from "./verify-hyperdrive-preview.mjs";

test("rejects wrong preview identity", () => {
  assert.throws(() => assertPreviewIdentity({ ok: true, database: "production", user: "vapt_api_preview" }), /identity/);
  assert.throws(() => assertPreviewIdentity({ ok: true, database: "vapt", user: "neondb_owner" }), /identity/);
  assert.deepEqual(assertPreviewIdentity({ ok: true, database: "vapt", user: "vapt_api_preview" }), {
    database: "vapt", user: "vapt_api_preview",
  });
});

test("rejects failed transaction", () => {
  for (const failed of ["rollbackAbsent", "committedVisible", "cleaned"]) {
    const result = { ok: true, rollbackAbsent: true, committedVisible: true, cleaned: true, [failed]: false };
    assert.throws(() => assertTransaction(result), /transaction/);
  }
  assert.equal(assertTransaction({ ok: true, rollbackAbsent: true, committedVisible: true, cleaned: true }), true);
});

test("rejects cache-enabled or wrong-origin Hyperdrive metadata", () => {
  const good = {
    id: "0c05fec2924b4f3b9225f3d689ba7ea9",
    caching: { disabled: true },
    origin: { database: "vapt", host: "ep-preview.sa-east-1.aws.neon.tech", user: "vapt_api_preview", port: 5432 },
  };
  const expectedHost = "ep-preview.sa-east-1.aws.neon.tech";
  assert.throws(() => assertCacheDisabledResource({ ...good, caching: { disabled: false } }, expectedHost), /Hyperdrive/);
  assert.throws(() => assertCacheDisabledResource({ ...good, origin: { ...good.origin, host: "ep-wrong.sa-east-1.aws.neon.tech" } }, expectedHost), /Hyperdrive/);
  assert.equal(assertCacheDisabledResource(good, expectedHost), good.id);
});

test("redacts secrets and unknown fields from output", () => {
  const secret = "sentinel-probe-token-never-print";
  const summary = safeSummary({
    identity: { database: "vapt", user: "vapt_api_preview", token: secret },
    transaction: { rollbackAbsent: true, committedVisible: true, cleaned: true },
    extra: { password: secret },
  });
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret));
  assert.deepEqual(summary, {
    database: "vapt", user: "vapt_api_preview",
    rollbackAbsent: true, committedVisible: true, cleaned: true,
  });
});
