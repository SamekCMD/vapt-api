import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.js";
import {
  createRestaurantAccessChecker,
  createSupabaseMembershipLookup,
  hasRestaurantCapability,
  type OrganizationRole,
  type RestaurantCapability,
} from "./permissions.js";

const roles: OrganizationRole[] = ["owner", "admin", "manager", "staff"];

const expectedCapabilities: Record<RestaurantCapability, OrganizationRole[]> = {
  "restaurant.read": roles,
  "restaurant.operate": roles,
  "restaurant.manage": ["owner", "admin", "manager"],
  "billing.read": ["owner", "admin", "manager"],
  "billing.manage": ["owner", "admin"],
};

for (const [capability, allowedRoles] of Object.entries(expectedCapabilities) as Array<
  [RestaurantCapability, OrganizationRole[]]
>) {
  test(`${capability} follows the approved organization role matrix`, () => {
    for (const role of roles) {
      assert.equal(
        hasRestaurantCapability(role, capability),
        allowedRoles.includes(role),
        `${role} capability mismatch`,
      );
    }
  });
}

test("restaurant access checker allows an active member with the required capability", async () => {
  const assertAccess = createRestaurantAccessChecker(async () => ({
    organizationId: "org-1",
    role: "manager",
  }));

  await assert.doesNotReject(() => assertAccess({
    userId: "user-1",
    restaurantId: "rest-1",
    capability: "restaurant.manage",
  }));
});

test("restaurant access checker rejects a member without the required capability", async () => {
  const assertAccess = createRestaurantAccessChecker(async () => ({
    organizationId: "org-1",
    role: "staff",
  }));

  await assert.rejects(
    () => assertAccess({
      userId: "user-1",
      restaurantId: "rest-1",
      capability: "billing.manage",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
});

test("restaurant access checker rejects a non-member", async () => {
  const assertAccess = createRestaurantAccessChecker(async () => null);

  await assert.rejects(
    () => assertAccess({
      userId: "outsider",
      restaurantId: "rest-1",
      capability: "restaurant.read",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
});

type QueryResponse = {
  data: Record<string, unknown> | null;
  error: { message?: string } | null;
};

function createLookupClient(input: {
  restaurant?: QueryResponse;
  membership?: QueryResponse;
  calls?: string[];
}) {
  const calls = input.calls ?? [];

  return {
    from(table: string) {
      calls.push(`from:${table}`);

      if (table === "restaurants") {
        return {
          select(columns: string) {
            calls.push(`restaurant.select:${columns}`);
            return {
              eq(column: string, value: string) {
                calls.push(`restaurant.eq:${column}:${value}`);
                return {
                  maybeSingle: async () => input.restaurant ?? {
                    data: { organization_id: "org-1" },
                    error: null,
                  },
                };
              },
            };
          },
        };
      }

      const filters: string[] = [];
      const membershipQuery = {
        eq(column: string, value: string) {
          filters.push(`${column}:${value}`);
          calls.push(`membership.eq:${column}:${value}`);
          return membershipQuery;
        },
        maybeSingle: async () => input.membership ?? {
          data: { role: "admin", status: "active" },
          error: null,
        },
      };

      return {
        select(columns: string) {
          calls.push(`membership.select:${columns}`);
          return membershipQuery;
        },
      };
    },
  } as unknown as Parameters<typeof createSupabaseMembershipLookup>[0];
}

test("Supabase membership lookup resolves restaurant organization and active membership", async () => {
  const calls: string[] = [];
  const lookup = createSupabaseMembershipLookup(createLookupClient({ calls }));

  const membership = await lookup({ userId: "user-1", restaurantId: "rest-1" });

  assert.deepEqual(membership, { organizationId: "org-1", role: "admin" });
  assert.deepEqual(calls, [
    "from:restaurants",
    "restaurant.select:organization_id",
    "restaurant.eq:id:rest-1",
    "from:organization_members",
    "membership.select:role,status",
    "membership.eq:organization_id:org-1",
    "membership.eq:user_id:user-1",
  ]);
});

for (const status of ["invited", "disabled"]) {
  test(`Supabase membership lookup rejects ${status} memberships`, async () => {
    const lookup = createSupabaseMembershipLookup(createLookupClient({
      membership: { data: { role: "manager", status }, error: null },
    }));

    assert.equal(await lookup({ userId: "user-1", restaurantId: "rest-1" }), null);
  });
}

test("Supabase membership lookup fails closed for an unknown role", async () => {
  const lookup = createSupabaseMembershipLookup(createLookupClient({
    membership: { data: { role: "superadmin", status: "active" }, error: null },
  }));

  assert.equal(await lookup({ userId: "user-1", restaurantId: "rest-1" }), null);
});

test("Supabase membership lookup returns no access across organizations", async () => {
  const lookup = createSupabaseMembershipLookup(createLookupClient({
    restaurant: { data: { organization_id: "org-b" }, error: null },
    membership: { data: null, error: null },
  }));

  assert.equal(await lookup({ userId: "member-of-org-a", restaurantId: "rest-b" }), null);
});

test("Supabase membership lookup returns no access for an unknown restaurant", async () => {
  const calls: string[] = [];
  const lookup = createSupabaseMembershipLookup(createLookupClient({
    restaurant: { data: null, error: null },
    calls,
  }));

  assert.equal(await lookup({ userId: "user-1", restaurantId: "missing" }), null);
  assert.equal(calls.includes("from:organization_members"), false);
});

test("Supabase membership lookup throws when restaurant resolution fails", async () => {
  const lookup = createSupabaseMembershipLookup(createLookupClient({
    restaurant: { data: null, error: { message: "boom" } },
  }));

  await assert.rejects(
    () => lookup({ userId: "user-1", restaurantId: "rest-1" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 500 &&
      error.code === "internal_error",
  );
});

test("Supabase membership lookup throws when membership resolution fails", async () => {
  const lookup = createSupabaseMembershipLookup(createLookupClient({
    membership: { data: null, error: { message: "boom" } },
  }));

  await assert.rejects(
    () => lookup({ userId: "user-1", restaurantId: "rest-1" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 500 &&
      error.code === "internal_error",
  );
});
