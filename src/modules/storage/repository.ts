import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";

export type MenuItemExists = (input: {
  userId: string;
  restaurantId: string;
  itemId: string;
}) => Promise<boolean>;

export function createMenuItemExists(database: Queryable): MenuItemExists {
  return async ({ userId, restaurantId, itemId }) => {
    try {
      const result = await database.query<{ exists: boolean }>(
        `select exists (
          select 1
          from public.menu_items as item
          join public.restaurants as restaurant on restaurant.id = item.restaurant_id
          where item.id = $1::uuid
            and restaurant.id = $2::uuid
            and restaurant.owner_id = $3::uuid
        ) as exists`,
        [itemId, restaurantId, userId],
      );
      return result.rows[0]?.exists === true;
    } catch {
      throw new AppError(500, "internal_error", "Failed to verify menu item");
    }
  };
}
