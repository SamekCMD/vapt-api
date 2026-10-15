import { z } from "zod";

import type { Queryable } from "./database.js";
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

const uuidSchema = z.string().uuid();

export function createOwnershipLookup(database: Queryable): OwnershipLookup {
  return async ({ userId, restaurantId }) => {
    if (!uuidSchema.safeParse(restaurantId).success || !uuidSchema.safeParse(userId).success) {
      throw new AppError(400, "invalid_request", "Invalid request");
    }

    try {
      const result = await database.query<{ allowed: boolean }>(
        `select exists (
          select 1
          from public.restaurants
          where id = $1::uuid and owner_id = $2::uuid
        ) as allowed`,
        [restaurantId, userId],
      );
      return result.rows[0]?.allowed === true;
    } catch {
      throw new AppError(500, "internal_error", "Failed to verify restaurant access");
    }
  };
}
