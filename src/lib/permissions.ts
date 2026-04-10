import { AppError } from "./errors.js";

export type RestaurantAccessChecker = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<void>;

export function createRestaurantAccessChecker(
  ownershipLookup: (input: { userId: string; restaurantId: string }) => Promise<boolean>,
): RestaurantAccessChecker {
  return async ({ userId, restaurantId }) => {
    const allowed = await ownershipLookup({ userId, restaurantId });

    if (!allowed) {
      throw new AppError(403, "forbidden", "Forbidden");
    }
  };
}
