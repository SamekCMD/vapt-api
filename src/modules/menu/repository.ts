import type { Database, Queryable } from "../../lib/database.js";
import { withTransaction } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { MenuItemDto, MenuVariationDto } from "../business/contracts.js";
import type {
  CreateMenuItemBody,
  MenuVariationInput,
  UpdateMenuItemBody,
} from "./schemas.js";

type MenuItemRow = {
  id: string;
  restaurant_id: string;
  name: string;
  price: string | number;
  description: string | null;
  category: string;
  available: boolean;
  image_url: string | null;
  available_from: string | null;
  available_until: string | null;
  badge: string | null;
  is_chef_suggestion: boolean;
  prep_time_minutes: number | null;
  created_at: string | Date;
  updated_at: string | Date;
  variations: MenuVariationDto[] | null;
};

export interface MenuRepository {
  listOwnedMenuItems(userId: string): Promise<MenuItemDto[]>;
  createOwnedMenuItem(userId: string, input: CreateMenuItemBody): Promise<MenuItemDto | null>;
  updateOwnedMenuItem(
    userId: string,
    itemId: string,
    patch: UpdateMenuItemBody,
  ): Promise<MenuItemDto | null>;
  deleteOwnedMenuItem(userId: string, itemId: string): Promise<boolean>;
}

const ITEM_SELECT = `
  item.id,
  item.restaurant_id,
  item.name,
  item.price,
  item.description,
  item.category,
  item.available,
  item.image_url,
  item.available_from,
  item.available_until,
  item.badge,
  item.is_chef_suggestion,
  item.prep_time_minutes,
  item.created_at,
  item.updated_at,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', variation.id,
        'name', variation.name,
        'options', variation.options,
        'required', variation.required
      )
      order by variation.created_at asc, variation.id asc
    ) filter (where variation.id is not null),
    '[]'::jsonb
  ) as variations
`;

const PATCH_COLUMNS: Record<Exclude<keyof UpdateMenuItemBody, "variations">, string> = {
  name: "name",
  price: "price",
  description: "description",
  category: "category",
  available: "available",
  imageUrl: "image_url",
  availableFrom: "available_from",
  availableUntil: "available_until",
  badge: "badge",
  isChefSuggestion: "is_chef_suggestion",
  prepTimeMinutes: "prep_time_minutes",
};

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function mapMenuItem(row: MenuItemRow): MenuItemDto {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    name: row.name,
    price: decimalString(row.price),
    description: row.description,
    category: row.category,
    available: row.available,
    imageUrl: row.image_url,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    badge: row.badge,
    isChefSuggestion: row.is_chef_suggestion,
    prepTimeMinutes: row.prep_time_minutes,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    variations: Array.isArray(row.variations) ? row.variations : [],
  };
}

function storageFailure(): AppError {
  return new AppError(500, "internal_error", "Failed to persist menu data");
}

async function loadOwnedItem(
  queryable: Queryable,
  userId: string,
  itemId: string,
): Promise<MenuItemDto | null> {
  const result = await queryable.query<MenuItemRow>(
    `select ${ITEM_SELECT}
    from public.menu_items as item
    join public.restaurants as restaurant
      on restaurant.id = item.restaurant_id
    left join public.menu_item_variations as variation
      on variation.menu_item_id = item.id
    where item.id = $1::uuid
      and restaurant.owner_id = $2::uuid
    group by item.id
    limit 1`,
    [itemId, userId],
  );
  const row = result.rows[0];
  return row ? mapMenuItem(row) : null;
}

async function replaceVariations(
  queryable: Queryable,
  itemId: string,
  variations: MenuVariationInput[],
): Promise<void> {
  await queryable.query(
    `delete from public.menu_item_variations
    where menu_item_id = $1::uuid`,
    [itemId],
  );
  for (const variation of variations) {
    await queryable.query(
      `insert into public.menu_item_variations (
        menu_item_id,
        name,
        options,
        required
      ) values ($1::uuid, $2::text, $3::text[], $4::boolean)`,
      [itemId, variation.name, variation.options, variation.required],
    );
  }
}

export function createMenuRepository(database: Database): MenuRepository {
  return {
    async listOwnedMenuItems(userId) {
      try {
        const result = await database.query<MenuItemRow>(
          `select ${ITEM_SELECT}
          from public.menu_items as item
          join public.restaurants as restaurant
            on restaurant.id = item.restaurant_id
          left join public.menu_item_variations as variation
            on variation.menu_item_id = item.id
          where restaurant.owner_id = $1::uuid
          group by item.id
          order by item.created_at desc, item.id desc`,
          [userId],
        );
        return result.rows.map(mapMenuItem);
      } catch {
        throw storageFailure();
      }
    },

    async createOwnedMenuItem(userId, input) {
      try {
        return await withTransaction(database, async (client) => {
          const restaurantResult = await client.query<{ id: string }>(
            `select restaurant.id
            from public.restaurants as restaurant
            where restaurant.owner_id = $1::uuid
            limit 1
            for update`,
            [userId],
          );
          const restaurant = restaurantResult.rows[0];
          if (!restaurant) return null;

          if (input.isChefSuggestion) {
            await client.query(
              `update public.menu_items
              set is_chef_suggestion = false, updated_at = now()
              where restaurant_id = $1::uuid
                and is_chef_suggestion = true`,
              [restaurant.id],
            );
          }

          const itemResult = await client.query<{ id: string }>(
            `insert into public.menu_items (
              restaurant_id,
              name,
              price,
              description,
              category,
              available,
              image_url,
              available_from,
              available_until,
              badge,
              is_chef_suggestion,
              prep_time_minutes
            ) values (
              $1::uuid, $2::text, $3::numeric, $4::text, $5::text, $6::boolean,
              $7::text, $8::text, $9::text, $10::text, $11::boolean, $12::integer
            )
            returning id`,
            [
              restaurant.id,
              input.name,
              input.price,
              input.description,
              input.category,
              input.available,
              input.imageUrl,
              input.availableFrom,
              input.availableUntil,
              input.badge,
              input.isChefSuggestion,
              input.prepTimeMinutes,
            ],
          );
          const item = itemResult.rows[0];
          if (!item) throw storageFailure();

          for (const variation of input.variations) {
            await client.query(
              `insert into public.menu_item_variations (
                menu_item_id,
                name,
                options,
                required
              ) values ($1::uuid, $2::text, $3::text[], $4::boolean)`,
              [item.id, variation.name, variation.options, variation.required],
            );
          }

          const created = await loadOwnedItem(client, userId, item.id);
          if (!created) throw storageFailure();
          return created;
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageFailure();
      }
    },

    async updateOwnedMenuItem(userId, itemId, patch) {
      try {
        return await withTransaction(database, async (client) => {
          const ownership = await client.query<{ restaurant_id: string }>(
            `select item.restaurant_id
            from public.menu_items as item
            join public.restaurants as restaurant
              on restaurant.id = item.restaurant_id
            where item.id = $1::uuid
              and restaurant.owner_id = $2::uuid
            for update of item, restaurant`,
            [itemId, userId],
          );
          const ownedItem = ownership.rows[0];
          if (!ownedItem) return null;

          if (patch.isChefSuggestion === true) {
            await client.query(
              `update public.menu_items
              set is_chef_suggestion = false, updated_at = now()
              where restaurant_id = $1::uuid
                and id <> $2::uuid
                and is_chef_suggestion = true`,
              [ownedItem.restaurant_id, itemId],
            );
          }

          const fieldEntries = Object.entries(patch).filter(
            ([key]) => key !== "variations",
          ) as Array<[
            Exclude<keyof UpdateMenuItemBody, "variations">,
            Exclude<UpdateMenuItemBody[keyof UpdateMenuItemBody], MenuVariationInput[]>,
          ]>;
          const assignments = fieldEntries.map(
            ([key], index) => `${PATCH_COLUMNS[key]} = $${index + 1}`,
          );
          const values = fieldEntries.map(([, value]) => value);
          values.push(itemId, userId);
          if (assignments.length > 0) {
            await client.query(
              `update public.menu_items as item
              set ${assignments.join(", ")}, updated_at = now()
              from public.restaurants as restaurant
              where item.id = $${fieldEntries.length + 1}::uuid
                and restaurant.id = item.restaurant_id
                and restaurant.owner_id = $${fieldEntries.length + 2}::uuid`,
              values,
            );
          } else {
            await client.query(
              `update public.menu_items as item
              set updated_at = now()
              from public.restaurants as restaurant
              where item.id = $1::uuid
                and restaurant.id = item.restaurant_id
                and restaurant.owner_id = $2::uuid`,
              [itemId, userId],
            );
          }

          if (patch.variations !== undefined) {
            await replaceVariations(client, itemId, patch.variations);
          }

          const updated = await loadOwnedItem(client, userId, itemId);
          if (!updated) throw storageFailure();
          return updated;
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageFailure();
      }
    },

    async deleteOwnedMenuItem(userId, itemId) {
      try {
        const result = await database.query<{ id: string }>(
          `delete from public.menu_items as item
          using public.restaurants as restaurant
          where item.id = $1::uuid
            and restaurant.id = item.restaurant_id
            and restaurant.owner_id = $2::uuid
          returning item.id`,
          [itemId, userId],
        );
        return Boolean(result.rows[0]);
      } catch {
        throw storageFailure();
      }
    },
  };
}
