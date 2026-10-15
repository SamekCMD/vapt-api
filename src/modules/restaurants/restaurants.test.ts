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

test("onboarding commits the restaurant and first dish in one transaction", async () => {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      events.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
      calls.push({ sql, values });
      if (/insert into public\.restaurants/i.test(sql)) return { rows: [rawRestaurant] };
      return { rows: [] };
    },
    release() {
      events.push("RELEASE");
    },
  };
  const database = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      events.push("CONNECT");
      return client;
    },
  } as unknown as Database;

  const created = await createRestaurantRepository(database).createOwnedRestaurant(ownerId, onboardingInput);

  assert.deepEqual(events, ["CONNECT", "BEGIN", "INSERT", "INSERT", "COMMIT", "RELEASE"]);
  assert.match(calls[1]?.sql ?? "", /insert into public\.restaurants/i);
  assert.match(calls[1]?.sql ?? "", /trial_ends_at/i);
  assert.deepEqual(calls[1]?.values, [ownerId, "Vapt Burger", "vapt-burger"]);
  assert.match(calls[2]?.sql ?? "", /insert into public\.menu_items/i);
  assert.deepEqual(calls[2]?.values, [restaurantId, "X-Burguer Especial", "29.90"]);
  assert.deepEqual(created, restaurantDto);
});

test("a first-dish failure rolls the entire onboarding transaction back", async () => {
  const events: string[] = [];
  const client = {
    async query(sql: string) {
      const operation = sql.trim().split(/\s+/)[0]!.toUpperCase();
      events.push(operation);
      if (/insert into public\.restaurants/i.test(sql)) return { rows: [rawRestaurant] };
      if (/insert into public\.menu_items/i.test(sql)) throw new Error("dish write failed with secret SQL");
      return { rows: [] };
    },
    release() {
      events.push("RELEASE");
    },
  };
  const database = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      events.push("CONNECT");
      return client;
    },
  } as unknown as Database;

  await assert.rejects(
    () => createRestaurantRepository(database).createOwnedRestaurant(ownerId, onboardingInput),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "internal_error");
      assert.doesNotMatch(error.message, /secret|dish write|sql/i);
      return true;
    },
  );
  assert.deepEqual(events, ["CONNECT", "BEGIN", "INSERT", "INSERT", "ROLLBACK", "RELEASE"]);
});

test("duplicate owner or slug conflicts are exposed as a safe 409", async () => {
  const client = {
    async query(sql: string) {
      if (/insert into public\.restaurants/i.test(sql)) {
        throw Object.assign(new Error("duplicate key owner_id secret"), {
          code: "23505",
          constraint: "restaurants_owner_id_unique",
        });
      }
      return { rows: [] };
    },
    release() {},
  };
  const database = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  } as unknown as Database;

  await assert.rejects(
    () => createRestaurantRepository(database).createOwnedRestaurant(ownerId, onboardingInput),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "restaurant_conflict");
      assert.doesNotMatch(error.message, /secret|owner_id/i);
      return true;
    },
  );
});

test("read and patch always scope the restaurant by the authenticated owner", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [rawRestaurant] };
    },
  } as unknown as Queryable;
  const repository = createRestaurantRepository(database as Database);

  const found = await repository.findOwnedRestaurant(ownerId);
  const updated = await repository.updateOwnedRestaurant(ownerId, {
    name: "Novo nome",
    deliveryEnabled: true,
  });

  assert.deepEqual(found, restaurantDto);
  assert.match(calls[0]?.sql ?? "", /where owner_id = \$1::uuid/i);
  assert.deepEqual(calls[0]?.values, [ownerId]);
  assert.match(calls[1]?.sql ?? "", /set name = \$1, delivery_enabled = \$2/i);
  assert.match(calls[1]?.sql ?? "", /where owner_id = \$3::uuid/i);
  assert.deepEqual(calls[1]?.values, ["Novo nome", true, ownerId]);
  assert.deepEqual(updated, restaurantDto);
});

test("service returns 404 when the authenticated owner has no restaurant", async () => {
  const repository: RestaurantRepository = {
    async createOwnedRestaurant() {
      return restaurantDto;
    },
    async findOwnedRestaurant() {
      return null;
    },
    async updateOwnedRestaurant() {
      return null;
    },
  };
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

test("authenticated onboarding derives owner from the session and returns 201", async () => {
  let receivedOwnerId: string | null = null;
  const repository: RestaurantRepository = {
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
  };
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

  assert.equal(response.statusCode, 201);
  assert.equal(receivedOwnerId, ownerId);
  assert.equal(response.json().id, restaurantId);

  const rejected = await app.inject({
    method: "POST",
    url: "/onboarding",
    payload: { ...onboardingInput, ownerId: "browser-owner" },
  });
  assert.equal(rejected.statusCode, 400);
  await app.close();
});
