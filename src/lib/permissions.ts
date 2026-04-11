import { AppError } from "./errors.js";

export type OwnershipLookup = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<boolean>;

export type RestaurantAccessChecker = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<void>;

export function createRestaurantAccessChecker(
  ownershipLookup: OwnershipLookup,
): RestaurantAccessChecker {
  return async ({ userId, restaurantId }) => {
    const allowed = await ownershipLookup({ userId, restaurantId });

    if (!allowed) {
      throw new AppError(403, "forbidden", "Forbidden");
    }
  };
}

export const testOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

type OwnershipLookupClient = {
  from: (table: "restaurants") => {
    select: (columns: "id") => {
      eq: (column: "id", value: string) => {
        eq: (column: "owner_id", value: string) => {
          maybeSingle: () => Promise<{ data: { id: string } | null; error: { message?: string } | null }>;
        };
      };
    };
  };
};

export function createSupabaseOwnershipLookup(client: OwnershipLookupClient): OwnershipLookup {
  return async ({ userId, restaurantId }) => {
    const result = await client
      .from("restaurants")
      .select("id")
      .eq("id", restaurantId)
      .eq("owner_id", userId)
      .maybeSingle();

    if (result.error) {
      const details = result.error.message?.trim() || "unknown supabase error";
      throw new AppError(
        500,
        "internal_error",
        `Failed to verify restaurant access: ${details}`,
      );
    }

    return Boolean(result.data);
  };
}
