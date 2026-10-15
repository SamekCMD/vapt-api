import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Queryable } from "../../lib/database.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import {
  createCatalogRepository,
  type CatalogRepository,
} from "./repository.js";
import { registerCatalogRoutes } from "./routes.js";

const restaurantId = "30000000-0000-4000-8000-000000000001";
const updatedAt = new Date("2026-09-25T12:00:00.000Z");

const restaurantRow = {
  id: restaurantId,
  name: "Vapt Bistrô",
  slug: "vapt-bistro",
  whatsapp: "5561999999999",
  address: "Rua Um, 42",
  phone: null,
  hours: "11h–22h",
  description: "Comida rápida de verdade",
  primary_color: "#0ea573",
  secondary_color: "#1e293b",
  font_family: "modern",
  logo_url: null,
  total_tables: 12,
  max_tables: 20,
  payment_mode: "open_tab",
  max_pending_orders: 3,
  local_enabled: true,
  delivery_enabled: true,
  updated_at: updatedAt,
};

const itemRows = [
  {
    id: "10000000-0000-4000-8000-000000000002",
    restaurant_id: restaurantId,
    name: "Água",
    price: "5.00",
    description: null,
    category: "Bebidas",
    available: true,
    image_url: null,
    available_from: null,
    available_until: null,
    badge: null,
    is_chef_suggestion: false,
    prep_time_minutes: null,
    created_at: new Date("2026-09-24T12:00:00.000Z"),
    updated_at: updatedAt,
    variations: [],
  },
  {
    id: "10000000-0000-4000-8000-000000000001",
    restaurant_id: restaurantId,
    name: "Prato do dia",
    price: "23.50",
    description: "Arroz, feijão e salada",
    category: "Pratos",
    available: true,
    image_url: "https://images.vapt.test/prato.webp",
    available_from: "11:00",
    available_until: "15:00",
    badge: "Popular",
    is_chef_suggestion: true,
    prep_time_minutes: 15,
    created_at: new Date("2026-09-23T12:00:00.000Z"),
    updated_at: updatedAt,
    variations: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        name: "Tamanho",
        options: ["P", "G"],
        required: true,
      },
    ],
  },
];

test("catalog repository uses two parameterized queries and maps public DTOs", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const responses = [{ rows: [restaurantRow] }, { rows: itemRows }];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return responses.shift() ?? { rows: [] };
    },
  } as unknown as Queryable;

  const catalog = await createCatalogRepository(database).findPublishedBySlug("vapt-bistro");

  assert.ok(catalog);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.values, ["vapt-bistro"]);
  assert.deepEqual(calls[1]?.values, [restaurantId]);
  assert.match(calls[0]?.sql ?? "", /where\s+slug\s*=\s*\$1/i);
  assert.match(calls[1]?.sql ?? "", /menu_item_variations/i);
  assert.match(calls[1]?.sql ?? "", /available\s*=\s*true/i);
  assert.match(calls[1]?.sql ?? "", /order by\s+item\.category.*item\.name.*item\.id/is);
  assert.equal(catalog.restaurant.updatedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(catalog.items[1]?.price, "23.50");
  assert.equal(catalog.items[1]?.createdAt, "2026-09-23T12:00:00.000Z");
  assert.deepEqual(catalog.items[1]?.variations, [{
    id: "40000000-0000-4000-8000-000000000001",
    name: "Tamanho",
    options: ["P", "G"],
    required: true,
  }]);

  const serialized = JSON.stringify(catalog);
  for (const forbidden of [
    "ownerId",
    "owner_id",
    "cnpj",
    "stripeCustomerId",
    "stripe_customer_id",
    "asaasApiKey",
    "asaas_api_key",
    "planType",
    "trialEndsAt",
    "onboardingCompleted",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be exposed`);
  }
});

test("catalog repository does not query menu data when the slug does not exist", async () => {
  let queryCount = 0;
  const database = {
    async query() {
      queryCount += 1;
      return { rows: [] };
    },
  } as unknown as Queryable;

  const catalog = await createCatalogRepository(database).findPublishedBySlug("missing");

  assert.equal(catalog, null);
  assert.equal(queryCount, 1);
});

test("GET public catalog returns 404 without leaking whether private rows exist", async () => {
  const repository: CatalogRepository = {
    async findPublishedBySlug() {
      return null;
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerCatalogRoutes(app, repository);

  const response = await app.inject({
    method: "GET",
    url: "/public/restaurants/missing/catalog",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: { code: "not_found", message: "Restaurant not found" },
  });
  await app.close();
});

test("GET public catalog returns the repository contract without internal fields", async () => {
  const database = {
    async query(_sql: string, values?: unknown[]) {
      return values?.[0] === "vapt-bistro"
        ? { rows: [restaurantRow] }
        : { rows: itemRows };
    },
  } as unknown as Queryable;
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerCatalogRoutes(app, createCatalogRepository(database));

  const response = await app.inject({
    method: "GET",
    url: "/public/restaurants/vapt-bistro/catalog",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().restaurant.slug, "vapt-bistro");
  assert.equal(response.json().items.length, 2);
  assert.equal("ownerId" in response.json().restaurant, false);
  assert.equal("cnpj" in response.json().restaurant, false);
  await app.close();
});
