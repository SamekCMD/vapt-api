import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { Database, Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { registerAuthDecorator } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { RestaurantDto } from "../business/contracts.js";
import {
  createRestaurantRepository,
  type RestaurantRepository,
} from "./repository.js";
import { registerRestaurantRoutes } from "./routes.js";
import {
  onboardingBodySchema,
  updateOwnedRestaurantBodySchema,
} from "./schemas.js";
import { createRestaurantService } from "./service.js";

const ownerId = "20000000-0000-4000-8000-000000000001";
const restaurantId = "10000000-0000-4000-8000-000000000001";

const rawRestaurant = {
  id: restaurantId,
  name: "Vapt Burger",
  slug: "vapt-burger",
  cnpj: null,
  whatsapp: null,
  address: null,
  phone: null,
  hours: null,
  description: null,
  primary_color: "#5C8A72",
  secondary_color: "#111114",
  font_family: "modern",
  logo_url: null,
  plan_type: "starter",
  plan_status: "trialing",
  trial_ends_at: new Date("2026-09-29T12:00:00.000Z"),
  total_tables: 1,
  max_tables: 1,
  payment_mode: "open_tab",
  max_pending_orders: 3,
  local_enabled: true,
  delivery_enabled: false,
  onboarding_completed: true,
  updated_at: new Date("2026-09-26T12:00:00.000Z"),
};

const restaurantDto: RestaurantDto = {
  id: restaurantId,
  name: "Vapt Burger",
  slug: "vapt-burger",
  cnpj: null,
  whatsapp: null,
  address: null,
  phone: null,
  hours: null,
  description: null,
  primaryColor: "#5C8A72",
  secondaryColor: "#111114",
  fontFamily: "modern",
  logoUrl: null,
  planType: "starter",
  planStatus: "trialing",
  trialEndsAt: "2026-09-29T12:00:00.000Z",
  totalTables: 1,
  maxTables: 1,
  paymentMode: "open_tab",
  maxPendingOrders: 3,
  localEnabled: true,
  deliveryEnabled: false,
  onboardingCompleted: true,
  updatedAt: "2026-09-26T12:00:00.000Z",
};

const onboardingInput = {
  restaurantName: "Vapt Burger",
  slug: "vapt-burger",
  dishName: "X-Burguer Especial",
  dishPrice: "29.90",
};

test('retired owner-only onboarding cannot execute legacy SQL or bypass canonical draft routines',async()=>{
  let writes=0;
  const database={async query(){writes++;throw new Error('Legacy SQL forbidden');},async connect(){writes++;throw new Error('Legacy transaction forbidden');}} as unknown as Database;
  await assert.rejects(createRestaurantRepository(database).createOwnedRestaurant(ownerId,onboardingInput),{statusCode:410,code:'legacy_onboarding_retired'});
  assert.equal(writes,0);
});

function testRestaurantRepository(overrides:Partial<RestaurantRepository>):RestaurantRepository {
  const unexpected=async()=>{ throw new Error('Unexpected repository operation in this unit fixture'); };
  return { resolveLegacyRestaurant:unexpected,getRestaurant:unexpected,updateRestaurant:unexpected,
    createOwnedRestaurant:unexpected,findOwnedRestaurant:unexpected,updateOwnedRestaurant:unexpected,...overrides };
}

test('legacy restaurant writes require internal session metadata, never owner-only SQL',async()=>{
  let queries=0;
  const database={ async query(){ queries++; throw new Error('Unexpected SQL'); },
    async connect(){ queries++; throw new Error('Unexpected transaction'); } } as unknown as Database;
  await assert.rejects(createRestaurantRepository(database).updateOwnedRestaurant(ownerId,{ name:'Sem sessão' }),{ statusCode:401 });
  assert.equal(queries,0);
});

test("onboarding accepts only the four server-owned contract fields", () => {
  assert.equal(onboardingBodySchema.safeParse(onboardingInput).success, true);

  for (const field of [
    "ownerId",
    "id",
    "planType",
    "planStatus",
    "trialEndsAt",
    "stripeCustomerId",
    "asaasApiKey",
    "totalTables",
  ]) {
    assert.equal(
      onboardingBodySchema.safeParse({ ...onboardingInput, [field]: "attacker-controlled" }).success,
      false,
      `${field} must be rejected`,
    );
  }
});

test("restaurant patch has an explicit allow-list and rejects tenant, plan, and billing fields", () => {
  assert.equal(updateOwnedRestaurantBodySchema.safeParse({
    name: "Novo nome",
    address: "Rua Um, 42",
    primaryColor: "#0ea573",
    maxTables: 20,
    deliveryEnabled: true,
  }).success, true);

  for (const field of [
    "id",
    "ownerId",
    "planType",
    "planStatus",
    "trialEndsAt",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "asaasApiKey",
  ]) {
    assert.equal(
      updateOwnedRestaurantBodySchema.safeParse({ name: "Novo nome", [field]: "forbidden" }).success,
      false,
      `${field} must be rejected`,
    );
  }
  assert.equal(updateOwnedRestaurantBodySchema.safeParse({}).success, false);
});

test("service returns 404 when the authenticated owner has no restaurant", async () => {
  const repository = testRestaurantRepository({
    async createOwnedRestaurant() {
      return restaurantDto;
    },
    async findOwnedRestaurant() {
      return null;
    },
    async updateOwnedRestaurant() {
      return null;
    },
  });
  const service = createRestaurantService(repository);

  await assert.rejects(() => service.getOwnedRestaurant(ownerId), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(
    () => service.updateOwnedRestaurant(ownerId, { name: "Novo nome" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("authenticated legacy onboarding is explicitly retired without invoking owner-only creation", async () => {
  let receivedOwnerId: string | null = null;
  const repository = testRestaurantRepository({
    async createOwnedRestaurant(userId) {
      receivedOwnerId = userId;
      return restaurantDto;
    },
    async findOwnedRestaurant() {
      return restaurantDto;
    },
    async updateOwnedRestaurant() {
      return restaurantDto;
    },
  });
  const app = Fastify({ logger: false });
  registerAuthDecorator(app, async () => ({
    userId: ownerId,
    email: "owner@vapt.test",
    role: "authenticated",
  }));
  registerErrorHandler(app);
  await registerRestaurantRoutes(app, repository);

  const response = await app.inject({
    method: "POST",
    url: "/onboarding",
    payload: onboardingInput,
  });

  assert.equal(response.statusCode, 410);
  assert.equal(receivedOwnerId, null);
  assert.equal(response.json().error.code, 'legacy_onboarding_retired');

  const rejected = await app.inject({
    method: "POST",
    url: "/onboarding",
    payload: { ...onboardingInput, ownerId: "browser-owner" },
  });
  assert.equal(rejected.statusCode, 400);
  await app.close();
});

test('explicit restaurant routes capture path tenant and verified session, never a body owner', async () => {
  const captured: unknown[] = [];
  const sessionId = '20000000-0000-4000-8000-000000000002';
  const sessionExpiresAt = Date.now()+60_000;
  const repository = {
    async getRestaurant(scope: unknown) { captured.push(scope); return restaurantDto; },
    async updateRestaurant(scope: unknown) { captured.push(scope); return restaurantDto; },
  } as unknown as RestaurantRepository;
  const app = Fastify({ logger:false });
  registerAuthDecorator(app,async()=>({ userId:ownerId,email:null,role:'authenticated',sessionId,sessionExpiresAt }));
  registerErrorHandler(app); await registerRestaurantRoutes(app,repository);
  try {
    const read = await app.inject({ method:'GET',url:`/restaurants/${restaurantId}` });
    assert.equal(read.statusCode,200);
    const write = await app.inject({ method:'PATCH',url:`/restaurants/${restaurantId}`,payload:{ name:'Nome explícito' } });
    assert.equal(write.statusCode,200);
    assert.deepEqual(captured,[{ userId:ownerId,restaurantId },{ userId:ownerId,restaurantId,sessionId,sessionExpiresAt }]);
    assert.equal((await app.inject({ method:'PATCH',url:`/restaurants/${restaurantId}`,payload:{ name:'Forjado',ownerId } })).statusCode,400);
  } finally { await app.close(); }
});
