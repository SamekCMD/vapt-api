import { AppError } from "../../lib/errors.js";

export type MenuItemExists = (input: {
  restaurantId: string;
  itemId: string;
}) => Promise<boolean>;

type MenuItemLookupClient = {
  from: (table: "menu_items") => {
    select: (columns: "id") => {
      eq: (column: "id", value: string) => {
        eq: (column: "restaurant_id", value: string) => {
          maybeSingle: () => Promise<{
            data: { id: string } | null;
            error: { message?: string } | null;
          }>;
        };
      };
    };
  };
};

export function createSupabaseMenuItemExists(client: MenuItemLookupClient): MenuItemExists {
  return async ({ restaurantId, itemId }) => {
    const result = await client
      .from("menu_items")
      .select("id")
      .eq("id", itemId)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();

    if (result.error) {
      const details = result.error.message?.trim() || "unknown supabase error";
      throw new AppError(
        500,
        "internal_error",
        "Failed to verify menu item",
        { storage: details },
      );
    }

    return Boolean(result.data);
  };
}
