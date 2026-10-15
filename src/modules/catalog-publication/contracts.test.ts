import assert from "node:assert/strict";
import test from "node:test";

import { compareVersion, parseCatalogSignal, type CatalogCommand } from "./contracts.js";
import { affectsPublicCatalog, allocateOnboardingRestaurantId, fingerprintCommand } from "./policy.js";

const userId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const restaurantId = "33333333-3333-4333-8333-333333333333";
const command: CatalogCommand = {
  operationId, restaurantId,
  actor: { userId, sessionId: "44444444-4444-4444-8444-444444444444", sessionExpiresAt: 2_000_000_000_000 },
  mutation: { type: "restaurant.patch", input: { name: "Bistrô", cnpj: null } },
};

test("canonicalVersion compares decimal revisions without Number rounding", () => {
  assert.equal(compareVersion("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareVersion("9", "10"), -1);
  assert.equal(compareVersion("12", "12"), 0);
  for (const invalid of ["0", "01", "-1", "1e3", "1.0", " 1", "", "9223372036854775808"]) {
    assert.throws(() => compareVersion(invalid, "1"));
    assert.throws(() => compareVersion("1", invalid));
  }
  assert.equal(compareVersion("9223372036854775807", "1"), 1);
});

test("publicFieldsOnly recognizes every mutable public restaurant field, not private timestamps", () => {
  for (const field of ["name", "slug", "whatsapp", "address", "phone", "hours", "description",
    "primaryColor", "secondaryColor", "fontFamily", "logoUrl", "totalTables", "maxTables",
    "paymentMode", "maxPendingOrders", "localEnabled", "deliveryEnabled"]) {
    assert.equal(affectsPublicCatalog({ [field]: null }), true, field);
  }
  assert.equal(affectsPublicCatalog({ cnpj: "synthetic", updatedAt: "2026-10-15", planStatus: "active" }), false);
  assert.equal(affectsPublicCatalog({ cnpj: null, deliveryEnabled: false }), true);
  assert.equal(affectsPublicCatalog({}), false);
  assert.equal(affectsPublicCatalog(Object.create({ name: "inherited" })), false);
});

test("deterministicOnboardingId reuses a server-derived UUID across retries", async () => {
  const id = await allocateOnboardingRestaurantId(userId, operationId);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await allocateOnboardingRestaurantId(userId, operationId), id);
  assert.notEqual(await allocateOnboardingRestaurantId(restaurantId, operationId), id);
  assert.notEqual(await allocateOnboardingRestaurantId(userId, restaurantId), id);
  await assert.rejects(allocateOnboardingRestaurantId("not-a-uuid", operationId));
});

test("mutationFingerprint canonicalizes objects but distinguishes actor, operation, target and payload", async () => {
  const original = await fingerprintCommand(command);
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(await fingerprintCommand({ ...command, mutation: { type: "restaurant.patch", input: { cnpj: null, name: "Bistrô" } } }), original);
  for (const changed of [
    { ...command, actor: { ...command.actor, userId: restaurantId } },
    { ...command, operationId: restaurantId },
    { ...command, restaurantId: operationId },
    { ...command, mutation: { type: "restaurant.patch" as const, input: { name: "Outro" } } },
  ]) assert.notEqual(await fingerprintCommand(changed), original);
  const item = { ...command, mutation: { type: "item.patch" as const, itemId: restaurantId,
    input: { variations: [{ name: "Molho", options: ["A", "B"], required: true }] } } };
  assert.notEqual(await fingerprintCommand(item), await fingerprintCommand({ ...item, mutation: {
    ...item.mutation, input: { variations: [{ name: "Molho", options: ["B", "A"], required: true }] },
  } }));
});

test("renewedSessionSameOperation does not turn session metadata into mutation identity", async () => {
  assert.equal(await fingerprintCommand({ ...command, actor: { ...command.actor,
    sessionId: restaurantId, sessionExpiresAt: 2_000_000_100_000 } }), await fingerprintCommand(command));
});

test("fingerprint rejects invalid command payloads instead of silently hashing a different action", async () => {
  const withExtra = { ...command, mutation: { ...command.mutation, input: { name: "Bistrô", ownerId: userId } } };
  await assert.rejects(fingerprintCommand(withExtra as CatalogCommand));
  await assert.rejects(fingerprintCommand({ ...command, operationId: "invalid" }));
});

test("public signals accept only public revision/address frames and enforce wire bytes", () => {
  const ready = { protocol: "vapt.catalog.v1", type: "ready", version: "9007199254740993" };
  assert.deepEqual(parseCatalogSignal(JSON.stringify(ready)), ready);
  const changed = { ...ready, type: "catalog_changed", canonicalSlug: "novo-bistro" };
  assert.deepEqual(parseCatalogSignal(JSON.stringify(changed)), changed);
  for (const field of ["ownerId", "sessionId", "orderId", "cnpj", "email", "token"]) {
    assert.equal(parseCatalogSignal(JSON.stringify({ ...ready, [field]: "private" })), null);
  }
  for (const data of ["null", "[]", "{}", "not-json", JSON.stringify({ ...ready, version: 1 }),
    JSON.stringify({ ...ready, protocol: "vapt.realtime.v1" }),
    JSON.stringify({ ...ready, canonicalSlug: "../other" }),
    JSON.stringify({ ...ready, type: "write" }),
    JSON.stringify(ready) + " ".repeat(512),
  ]) assert.equal(parseCatalogSignal(data), null);
  const padded = JSON.stringify(ready).padEnd(512, " ");
  assert.deepEqual(parseCatalogSignal(padded), ready);
  assert.equal(parseCatalogSignal(padded.slice(0, -1) + "é"), null, "UTF-8 limit, not JS length");
});
