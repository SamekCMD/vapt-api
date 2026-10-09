import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type {
  MenuItemDto,
  MenuVariationDto,
  PublicCatalogDto,
  PublicRestaurantDto,
} from "../business/contracts.js";

type PublicRestaurantRow = {
  id: string;
  name: string;
  slug: string;
  whatsapp: string | null;
  address: string | null;
  phone: string | null;
  hours: string | null;
  description: string | null;
  primary_color: string;
  secondary_color: string;
  font_family: string;
  logo_url: string | null;
  total_tables: number;
  max_tables: number;
  payment_mode: "open_tab" | "prepaid";
  max_pending_orders: number;
  local_enabled: boolean;
  delivery_enabled: boolean;
  updated_at: string | Date;
};

type PublicMenuItemRow = {
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

export interface CatalogRepository {
  findPublishedBySlug(slug: string): Promise<PublicCatalogDto | null>;
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function mapRestaurant(row: PublicRestaurantRow): PublicRestaurantDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    whatsapp: row.whatsapp,
    address: row.address,
    phone: row.phone,
    hours: row.hours,
    description: row.description,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    fontFamily: row.font_family,
    logoUrl: row.logo_url,
    totalTables: row.total_tables,
    maxTables: row.max_tables,
    paymentMode: row.payment_mode,
    maxPendingOrders: row.max_pending_orders,
    localEnabled: row.local_enabled,
    deliveryEnabled: row.delivery_enabled,
    updatedAt: isoString(row.updated_at),
  };
}

function mapMenuItem(row: PublicMenuItemRow): MenuItemDto {
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

function catalogStorageFailure(): AppError {
  return new AppError(500, "internal_error", "Failed to load public catalog");
}

export function createCatalogRepository(database: Queryable): CatalogRepository {
  return {
    async findPublishedBySlug(slug) {
      let restaurantResult;
      try {
        restaurantResult = await database.query<PublicRestaurantRow>(
          `select
            id,
            name,
            slug,
            whatsapp,
            address,
            phone,
            hours,
            description,
            primary_color,
            secondary_color,
            font_family,
            logo_url,
            total_tables,
            max_tables,
            payment_mode,
            max_pending_orders,
            local_enabled,
            delivery_enabled,
            updated_at
          from public.restaurants
          where slug = $1
          limit 1`,
          [slug],
        );
      } catch {
        throw catalogStorageFailure();
      }

      const restaurant = restaurantResult.rows[0];
      if (!restaurant) return null;

      let itemResult;
      try {
        itemResult = await database.query<PublicMenuItemRow>(
          `select
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
          from public.menu_items as item
          left join public.menu_item_variations as variation
            on variation.menu_item_id = item.id
          where item.restaurant_id = $1::uuid
            and item.available = true
          group by item.id
          order by item.category asc, item.name asc, item.id asc`,
          [restaurant.id],
        );
      } catch {
        throw catalogStorageFailure();
      }

      return {
        restaurant: mapRestaurant(restaurant),
        items: itemResult.rows.map(mapMenuItem),
      };
    },
  };
}
