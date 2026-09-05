import { AppError } from "./errors.js";

export type OrganizationRole = "owner" | "admin" | "manager" | "staff";

export type RestaurantCapability =
  | "restaurant.read"
  | "restaurant.operate"
  | "restaurant.manage"
  | "billing.read"
  | "billing.manage";

export type RestaurantMembership = {
  organizationId: string;
  role: OrganizationRole;
};

export type MembershipLookup = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<RestaurantMembership | null>;

export type RestaurantAccessChecker = (input: {
  userId: string;
  restaurantId: string;
  capability: RestaurantCapability;
}) => Promise<void>;

const organizationRoles = new Set<OrganizationRole>([
  "owner",
  "admin",
  "manager",
  "staff",
]);

const capabilityRoles: Record<RestaurantCapability, ReadonlySet<OrganizationRole>> = {
  "restaurant.read": organizationRoles,
  "restaurant.operate": organizationRoles,
  "restaurant.manage": new Set(["owner", "admin", "manager"]),
  "billing.read": new Set(["owner", "admin", "manager"]),
  "billing.manage": new Set(["owner", "admin"]),
};

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" && organizationRoles.has(value as OrganizationRole);
}

export function hasRestaurantCapability(
  role: OrganizationRole,
  capability: RestaurantCapability,
): boolean {
  return capabilityRoles[capability].has(role);
}

export function createRestaurantAccessChecker(
  membershipLookup: MembershipLookup,
): RestaurantAccessChecker {
  return async ({ userId, restaurantId, capability }) => {
    const membership = await membershipLookup({ userId, restaurantId });

    if (!membership || !hasRestaurantCapability(membership.role, capability)) {
      throw new AppError(403, "forbidden", "Forbidden");
    }
  };
}

export const testMembershipLookup: MembershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1"
    ? { organizationId: "org-1", role: "owner" }
    : null;

type QueryResult = {
  data: Record<string, unknown> | null;
  error: { message?: string } | null;
};

type RestaurantQuery = {
  select: (columns: "organization_id") => {
    eq: (column: "id", value: string) => {
      maybeSingle: () => Promise<QueryResult>;
    };
  };
};

type MembershipQuery = {
  select: (columns: "role,status") => {
    eq: (column: "organization_id", value: string) => {
      eq: (column: "user_id", value: string) => {
        maybeSingle: () => Promise<QueryResult>;
      };
    };
  };
};

type MembershipLookupClient = {
  from(table: "restaurants"): RestaurantQuery;
  from(table: "organization_members"): MembershipQuery;
};

function databaseFailure(): AppError {
  return new AppError(
    500,
    "internal_error",
    "Failed to verify restaurant access",
  );
}

export function createSupabaseMembershipLookup(
  client: MembershipLookupClient,
): MembershipLookup {
  return async ({ userId, restaurantId }) => {
    const restaurantResult = await client
      .from("restaurants")
      .select("organization_id")
      .eq("id", restaurantId)
      .maybeSingle();

    if (restaurantResult.error) {
      throw databaseFailure();
    }

    const organizationId = restaurantResult.data?.organization_id;
    if (typeof organizationId !== "string" || organizationId.trim() === "") {
      return null;
    }

    const membershipResult = await client
      .from("organization_members")
      .select("role,status")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipResult.error) {
      throw databaseFailure();
    }

    if (
      membershipResult.data?.status !== "active" ||
      !isOrganizationRole(membershipResult.data.role)
    ) {
      return null;
    }

    return {
      organizationId,
      role: membershipResult.data.role,
    };
  };
}
