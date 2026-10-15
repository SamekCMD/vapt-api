import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { MenuItemDto } from "../business/contracts.js";
import { createMenuRepository, type MenuRepository } from "./repository.js";
import { registerMenuRoutes } from "./routes.js";
import {
  createMenuItemBodySchema,
  type CreateMenuItemBody,
  updateMenuItemBodySchema,
} from "./schemas.js";
import { createMenuService } from "./service.js";

const ownerId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";
const itemId = "30000000-0000-4000-8000-000000000001";
const variationId = "40000000-0000-4000-8000-000000000001";

const validInput = {
  name: "X-Burguer Especial",
  price: "29.90",
  description: "Pão, carne e queijo",
  category: "Hambúrgueres",
  available: true,
  imageUrl: null,
  availableFrom: "11:00",
  availableUntil: "23:30",
  badge: "destaque",
  isChefSuggestion: true,
  prepTimeMinutes: 15,
  variations: [{ name: "Ponto da carne", options: ["Ao ponto", "Bem passado"], required: true }],
} satisfies CreateMenuItemBody;

const rawItem = {
  id: itemId,
  restaurant_id: restaurantId,
  name: validInput.name,
  price: validInput.price,
  description: validInput.description,
  category: validInput.category,
  available: true,
  image_url: null,
  available_from: "11:00",
  available_until: "23:30",
  badge: "destaque",
  is_chef_suggestion: true,
  prep_time_minutes: 15,
  created_at: new Date("2026-09-26T12:00:00.000Z"),
  updated_at: new Date("2026-09-26T12:00:00.000Z"),
  variations: [{
    id: variationId,
    name: "Ponto da carne",
    options: ["Ao ponto", "Bem passado"],
    required: true,
  }],
};

const menuItem: MenuItemDto = {
  id: itemId,
  restaurantId,
  name: validInput.name,
  price: validInput.price,
  description: validInput.description,
  category: validInput.category,
  available: true,
  imageUrl: null,
  availableFrom: "11:00",
  availableUntil: "23:30",
  badge: "destaque",
  isChefSuggestion: true,
  prepTimeMinutes: 15,
  createdAt: "2026-09-26T12:00:00.000Z",
  updatedAt: "2026-09-26T12:00:00.000Z",
  variations: rawItem.variations,
};

test("menu schemas reject negative prices, empty variations, tenant fields, and empty patches", () => {
  assert.equal(createMenuItemBodySchema.safeParse(validInput).success, true);
  assert.equal(createMenuItemBodySchema.safeParse({ ...validInput, price: "-1.00" }).success, false);
  assert.equal(createMenuItemBodySchema.safeParse({
    ...validInput,
    variations: [{ name: "Ponto", options: [], required: true }],
  }).success, false);
  assert.equal(createMenuItemBodySchema.safeParse({ ...validInput, restaurantId }).success, false);
  assert.equal(updateMenuItemBodySchema.safeParse({}).success, false);
  assert.equal(updateMenuItemBodySchema.safeParse({ ownerId }).success, false);
  assert.equal(updateMenuItemBodySchema.safeParse({ imageUrl: null }).success, true);
});

test("create locks the owned restaurant and commits item, chef uniqueness, and variations atomically", async () => {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      const operation = sql.trim().split(/\s+/)[0]!.toUpperCase();
      events.push(operation);
      calls.push({ sql, values });
      if (/select restaurant\.id/i.test(sql)) return { rows: [{ id: restaurantId }] };
      if (/insert into public\.menu_items/i.test(sql)) return { rows: [{ id: itemId }] };
      if (/from public\.menu_items as item/i.test(sql)) return { rows: [rawItem] };
      return { rows: [] };
    },
    release() { events.push("RELEASE"); },
  };
  const database = {
    async query() { return { rows: [] }; },
    async connect() { events.push("CONNECT"); return client; },
  } as unknown as Database;

  const created = await createMenuRepository(database).createOwnedMenuItem(ownerId, validInput);

  assert.deepEqual(created, menuItem);
  assert.deepEqual(events.slice(0, 3), ["CONNECT", "BEGIN", "SELECT"]);
  assert.equal(events.at(-2), "COMMIT");
  assert.equal(events.at(-1), "RELEASE");
  assert.match(calls[1]?.sql ?? "", /where restaurant\.owner_id = \$1::uuid[\s\S]*for update/i);
  assert.match(calls.map((call) => call.sql).join("\n"), /set is_chef_suggestion = false/i);
  assert.match(calls.map((call) => call.sql).join("\n"), /insert into public\.menu_item_variations/i);
  assert.deepEqual(calls.find((call) => /insert into public\.menu_item_variations/i.test(call.sql))?.values, [
    itemId,
    "Ponto da carne",
    ["Ao ponto", "Bem passado"],
    true,
  ]);
});

test("variation failure rolls back item creation", async () => {
  const events: string[] = [];
  const client = {
    async query(sql: string) {
      events.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
      if (/select restaurant\.id/i.test(sql)) return { rows: [{ id: restaurantId }] };
      if (/insert into public\.menu_items/i.test(sql)) return { rows: [{ id: itemId }] };
      if (/insert into public\.menu_item_variations/i.test(sql)) throw new Error("secret variation SQL failed");
      return { rows: [] };
    },
    release() { events.push("RELEASE"); },
  };
  const database = {
    async query() { return { rows: [] }; },
    async connect() { events.push("CONNECT"); return client; },
  } as unknown as Database;

  await assert.rejects(
    () => createMenuRepository(database).createOwnedMenuItem(ownerId, validInput),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "internal_error");
      assert.doesNotMatch(error.message, /secret|sql/i);
      return true;
    },
  );
  assert.equal(events.at(-2), "ROLLBACK");
  assert.equal(events.at(-1), "RELEASE");
});

test("update cannot touch another owner's item and replaces variations only after ownership validation", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (/select item\.restaurant_id/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const database = {
    async query() { return { rows: [] }; },
    async connect() { return client; },
  } as unknown as Database;
  const repository = createMenuRepository(database);

  const updated = await repository.updateOwnedMenuItem(ownerId, itemId, {
    name: "Ataque",
    variations: [{ name: "Tamanho", options: ["G"], required: true }],
  });

  assert.equal(updated, null);
  assert.match(calls[1]?.sql ?? "", /join public\.restaurants as restaurant/i);
  assert.match(calls[1]?.sql ?? "", /restaurant\.owner_id = \$2::uuid/i);
  assert.equal(calls.some((call) => /delete from public\.menu_item_variations/i.test(call.sql)), false);
  assert.equal(calls.some((call) => /^\s*update public\.menu_items/i.test(call.sql)), false);
});

test("owned update scopes the mutation and replaces variations in the same transaction", async () => {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      events.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
      calls.push({ sql, values });
      if (/select item\.restaurant_id/i.test(sql)) return { rows: [{ restaurant_id: restaurantId }] };
      if (/from public\.menu_items as item/i.test(sql)) return { rows: [rawItem] };
      return { rows: [] };
    },
    release() { events.push("RELEASE"); },
  };
  const database = {
    async query() { return { rows: [] }; },
    async connect() { events.push("CONNECT"); return client; },
  } as unknown as Database;

  const updated = await createMenuRepository(database).updateOwnedMenuItem(ownerId, itemId, {
    category: "Especiais",
    variations: [{ name: "Tamanho", options: ["M", "G"], required: true }],
  });

  assert.deepEqual(updated, menuItem);
  const itemUpdate = calls.find((call) => /update public\.menu_items as item/i.test(call.sql));
  assert.match(itemUpdate?.sql ?? "", /from public\.restaurants as restaurant/i);
  assert.match(itemUpdate?.sql ?? "", /restaurant\.owner_id = \$3::uuid/i);
  assert.deepEqual(itemUpdate?.values, ["Especiais", itemId, ownerId]);
  const deleteIndex = calls.findIndex((call) => /delete from public\.menu_item_variations/i.test(call.sql));
  const insertIndex = calls.findIndex((call) => /insert into public\.menu_item_variations/i.test(call.sql));
  assert.ok(deleteIndex > 0);
  assert.ok(insertIndex > deleteIndex);
  assert.equal(events.at(-2), "COMMIT");
  assert.equal(events.at(-1), "RELEASE");
});

test("delete scopes the mutation through the authenticated restaurant owner", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ id: itemId }] };
    },
  } as unknown as Database;

  const deleted = await createMenuRepository(database).deleteOwnedMenuItem(ownerId, itemId);

  assert.equal(deleted, true);
  assert.match(calls[0]?.sql ?? "", /delete from public\.menu_items as item/i);
  assert.match(calls[0]?.sql ?? "", /using public\.restaurants as restaurant/i);
  assert.match(calls[0]?.sql ?? "", /restaurant\.owner_id = \$2::uuid/i);
  assert.deepEqual(calls[0]?.values, [itemId, ownerId]);
});

test("service rejects image URLs outside the configured R2 public base", async () => {
  let mutations = 0;
  const repository: MenuRepository = {
    async listOwnedMenuItems() { return []; },
    async createOwnedMenuItem() { mutations += 1; return menuItem; },
    async updateOwnedMenuItem() { mutations += 1; return menuItem; },
    async deleteOwnedMenuItem() { return true; },
  };
  const service = createMenuService(repository, {
    publicBaseUrl: new URL("https://assets.vapt.test/menu/"),
  });

  await assert.rejects(
    () => service.updateOwnedMenuItem(ownerId, itemId, { imageUrl: "https://evil.test/steal.webp" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_image_url");
      return true;
    },
  );
  assert.equal(mutations, 0);
  await service.updateOwnedMenuItem(ownerId, itemId, {
    imageUrl: `https://assets.vapt.test/menu/${restaurantId}/${itemId}`,
  });
  assert.equal(mutations, 1);
});

test("authenticated menu routes derive tenant from the session", async () => {
  const owners: string[] = [];
  const repository: MenuRepository = {
    async listOwnedMenuItems(userId) { owners.push(userId); return [menuItem]; },
    async createOwnedMenuItem(userId) { owners.push(userId); return menuItem; },
    async updateOwnedMenuItem(userId) { owners.push(userId); return menuItem; },
    async deleteOwnedMenuItem(userId) { owners.push(userId); return true; },
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({ userId: ownerId, email: null, role: "authenticated" }));
  registerErrorHandler(app);
  await registerMenuRoutes(app, repository, { publicBaseUrl: new URL("https://assets.vapt.test/") });

  const listed = await app.inject({ method: "GET", url: "/restaurants/me/menu-items" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json()[0].id, itemId);

  const created = await app.inject({
    method: "POST",
    url: "/restaurants/me/menu-items",
    payload: validInput,
  });
  assert.equal(created.statusCode, 201);

  const patched = await app.inject({
    method: "PATCH",
    url: `/restaurants/me/menu-items/${itemId}`,
    payload: { available: false },
  });
  assert.equal(patched.statusCode, 200);

  const deleted = await app.inject({ method: "DELETE", url: `/restaurants/me/menu-items/${itemId}` });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual(owners, [ownerId, ownerId, ownerId, ownerId]);
  await app.close();
});
