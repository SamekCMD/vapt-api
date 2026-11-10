// Local test data only. Never import this module from a deployed entry point.
import type { CatalogState } from "../modules/catalog-publication/contracts.js";
import type { MenuItemDto } from "../modules/business/contracts.js";

const bytes = 8_388_608;
const restaurantId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-10-24T00:00:00Z";
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

export function structuredCatalogState(shape: "items" | "variations", version = "11", identity = { restaurantId, slug: "bistro" }): CatalogState {
  const state: CatalogState = { version, catalog: { restaurant: {
    id: identity.restaurantId, name: "Bistro", slug: identity.slug, whatsapp: null, address: null, phone: null,
    hours: null, description: null, primaryColor: "#123456", secondaryColor: "#654321",
    fontFamily: "modern", logoUrl: null, totalTables: 1, maxTables: 1, paymentMode: "open_tab",
    maxPendingOrders: 3, localEnabled: true, deliveryEnabled: true, updatedAt: timestamp,
  }, items: [] } };
  const item = (index: number): MenuItemDto => ({
    id: uuid(index * 21 + 1), restaurantId: identity.restaurantId, name: "Item", price: "1.00", description: "",
    category: "Menu", available: true, imageUrl: null, availableFrom: null, availableUntil: null,
    badge: null, isChefSuggestion: false, prepTimeMinutes: null, createdAt: timestamp, updatedAt: timestamp,
    variations: shape === "items" ? [] : Array.from({ length: 20 }, (_, variation) => ({
      id: uuid(index * 21 + variation + 2), name: "V", required: false,
      options: Array.from({ length: 50 }, (_, option) => `O${option}`),
    })),
  });
  // Fixed-width ASCII identities keep every serialized item the same size.
  // Compute the count once, not by repeatedly serializing a growing catalog.
  const baseBytes = Buffer.byteLength(JSON.stringify(state));
  const itemBytes = Buffer.byteLength(JSON.stringify(item(0)));
  const count = Math.floor((bytes - baseBytes + 1) / (itemBytes + 1));
  state.catalog.items = Array.from({ length: count }, (_, index) => item(index));
  let remaining = bytes - (baseBytes + count * (itemBytes + 1) - 1);
  for (const entry of state.catalog.items) {
    const padding = Math.min(remaining, 1000);
    entry.description = "a".repeat(padding); remaining -= padding;
    if (!remaining) break;
  }
  if (remaining || Buffer.byteLength(JSON.stringify(state)) !== bytes) throw new Error("Invalid structured test boundary");
  return state;
}
