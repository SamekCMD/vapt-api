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

function testMenuRepository(overrides:Partial<MenuRepository>):MenuRepository {
  const unexpected=async()=>{ throw new Error('Unexpected repository operation in this unit fixture'); };
  return { resolveLegacyRestaurant:unexpected,listMenuItems:unexpected,createMenuItem:unexpected,
    updateMenuItem:unexpected,deleteMenuItem:unexpected,listOwnedMenuItems:unexpected,createOwnedMenuItem:unexpected,
    updateOwnedMenuItem:unexpected,deleteOwnedMenuItem:unexpected,...overrides };
}

test('legacy menu writes reject userId-only authority before consulting the database',async()=>{
  let queries=0;
  const database={ async query(){ queries++; throw new Error('Unexpected SQL'); },
    async connect(){ queries++; throw new Error('Unexpected transaction'); } } as unknown as Database;
  const repository=createMenuRepository(database);
  await assert.rejects(repository.createOwnedMenuItem(ownerId,validInput),{ statusCode:401 });
  await assert.rejects(repository.updateOwnedMenuItem(ownerId,itemId,{ price:'10.00' }),{ statusCode:401 });
  await assert.rejects(repository.deleteOwnedMenuItem(ownerId,itemId),{ statusCode:401 });
  assert.equal(queries,0);
});

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






test("service rejects image URLs outside the configured R2 public base", async () => {
  let mutations = 0;
  const repository = testMenuRepository({
    async listOwnedMenuItems() { return []; },
    async createOwnedMenuItem() { mutations += 1; return menuItem; },
    async updateOwnedMenuItem() { mutations += 1; return menuItem; },
    async deleteOwnedMenuItem() { return true; },
  });
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
  const repository = testMenuRepository({
    async listOwnedMenuItems(userId) { owners.push(userId); return [menuItem]; },
    async createOwnedMenuItem(userId) { owners.push(userId); return menuItem; },
    async updateOwnedMenuItem(userId) { owners.push(userId); return menuItem; },
    async deleteOwnedMenuItem(userId) { owners.push(userId); return true; },
  });
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({ userId: ownerId, email: null, role: "authenticated", sessionId:"20000000-0000-4000-8000-000000000002",sessionExpiresAt:Date.now()+60_000 }));
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

test('explicit menu routes capture the restaurant path and internal write actor', async () => {
  const captured: unknown[] = [];
  const sessionId = '20000000-0000-4000-8000-000000000002', sessionExpiresAt=Date.now()+60_000;
  const repository = {
    async listMenuItems(scope: unknown) { captured.push(scope); return [menuItem]; },
    async createMenuItem(scope: unknown) { captured.push(scope); return menuItem; },
    async updateMenuItem(scope: unknown) { captured.push(scope); return menuItem; },
    async deleteMenuItem(scope: unknown) { captured.push(scope); return true; },
  } as unknown as MenuRepository;
  const app = Fastify({ logger:false });
  registerAuthDecorator(app,async()=>({ userId:ownerId,email:null,role:'authenticated',sessionId,sessionExpiresAt }));
  registerErrorHandler(app); await registerMenuRoutes(app,repository,{ publicBaseUrl:null });
  try {
    const path=`/restaurants/${restaurantId}/menu-items`;
    assert.equal((await app.inject({ method:'GET',url:path })).statusCode,200);
    assert.equal((await app.inject({ method:'POST',url:path,payload:validInput })).statusCode,201);
    assert.equal((await app.inject({ method:'PATCH',url:`${path}/${itemId}`,payload:{ available:false } })).statusCode,200);
    assert.equal((await app.inject({ method:'DELETE',url:`${path}/${itemId}` })).statusCode,204);
    assert.deepEqual(captured,[{ userId:ownerId,restaurantId },
      ...Array.from({ length:3 },()=>({ userId:ownerId,restaurantId,sessionId,sessionExpiresAt }))]);
    assert.equal((await app.inject({ method:'POST',url:path,payload:{ ...validInput,restaurantId } })).statusCode,400);
  } finally { await app.close(); }
});
