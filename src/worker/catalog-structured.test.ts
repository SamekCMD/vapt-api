import assert from "node:assert/strict";
import test from "node:test";
import { createMenuItemBodySchema } from "../modules/menu/schemas.js";
import { structuredCatalogState } from "./catalog-structured-test-support.js";

for (const shape of ["items", "variations"] as const) {
  test(`structured ${shape} fixture fills 8MiB using valid per-item HTTP inputs`, () => {
    const state = structuredCatalogState(shape);
    assert.ok(state, "structured fixture must exist");
    assert.equal(Buffer.byteLength(JSON.stringify(state)), 8_388_608);
    assert.equal(state.catalog.restaurant.description, null, "no giant restaurant text padding");
    assert.ok(state.catalog.items.length > (shape === "items" ? 10_000 : 500));
    const ids = new Set<string>();
    for (const item of state.catalog.items) {
      assert.equal(item.restaurantId, state.catalog.restaurant.id);
      for (const id of [item.id, ...item.variations.map(variation => variation.id)]) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(ids.has(id), false, "item/variation identities must be unique"); ids.add(id);
      }
      const { id, restaurantId, createdAt, updatedAt, variations, ...input } = item;
      const body = { ...input, variations: variations.map(({ id, ...variation }) => variation) };
      assert.equal(createMenuItemBodySchema.safeParse(body).success, true);
      assert.equal(variations.length, shape === "items" ? 0 : 20);
      if (shape === "variations") assert.ok(variations.every(variation => variation.options.length === 50));
    }
  });
}
