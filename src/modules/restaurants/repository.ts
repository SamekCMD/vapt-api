import type { Database } from "../../lib/database.js";
import { withTransaction } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { RestaurantDto } from "../business/contracts.js";
import type {
  OnboardingBody,
  UpdateOwnedRestaurantBody,
} from "./schemas.js";

type RestaurantRow = {
  id: string;
  name: string;
  slug: string;
  cnpj: string | null;
  whatsapp: string | null;
  address: string | null;
  phone: string | null;
  hours: string | null;
  description: string | null;
  primary_color: string;
  secondary_color: string;
  font_family: string;
  logo_url: string | null;
  plan_type: "starter" | "pro" | "business";
  plan_status: "trialing" | "active" | "expired" | "cancelled";
  trial_ends_at: string | Date | null;
  total_tables: number;
  max_tables: number;
  payment_mode: "open_tab" | "prepaid";
  max_pending_orders: number;
  local_enabled: boolean;
  delivery_enabled: boolean;
  onboarding_completed: boolean;
  updated_at: string | Date;
};

export interface RestaurantRepository {
  createOwnedRestaurant(userId: string, input: OnboardingBody): Promise<RestaurantDto>;
  findOwnedRestaurant(userId: string): Promise<RestaurantDto | null>;
  updateOwnedRestaurant(
    userId: string,
    patch: UpdateOwnedRestaurantBody,
  ): Promise<RestaurantDto | null>;
}

const RESTAURANT_COLUMNS = `
  id,
  name,
  slug,
  cnpj,
  whatsapp,
  address,
  phone,
  hours,
  description,
  primary_color,
  secondary_color,
  font_family,
  logo_url,
  plan_type,
  plan_status,
  trial_ends_at,
  total_tables,
  max_tables,
  payment_mode,
  max_pending_orders,
  local_enabled,
  delivery_enabled,
  onboarding_completed,
  updated_at
`;

const PATCH_COLUMNS: Record<keyof UpdateOwnedRestaurantBody, string> = {
  name: "name",
  slug: "slug",
  cnpj: "cnpj",
  whatsapp: "whatsapp",
  address: "address",
  phone: "phone",
  hours: "hours",
  description: "description",
  primaryColor: "primary_color",
  secondaryColor: "secondary_color",
  fontFamily: "font_family",
  logoUrl: "logo_url",
  totalTables: "total_tables",
  maxTables: "max_tables",
  paymentMode: "payment_mode",
  maxPendingOrders: "max_pending_orders",
  localEnabled: "local_enabled",
  deliveryEnabled: "delivery_enabled",
};

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRestaurant(row: RestaurantRow): RestaurantDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    cnpj: row.cnpj,
    whatsapp: row.whatsapp,
    address: row.address,
    phone: row.phone,
    hours: row.hours,
    description: row.description,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    fontFamily: row.font_family,
    logoUrl: row.logo_url,
    planType: row.plan_type,
    planStatus: row.plan_status,
    trialEndsAt: row.trial_ends_at === null ? null : isoString(row.trial_ends_at),
    totalTables: row.total_tables,
    maxTables: row.max_tables,
    paymentMode: row.payment_mode,
    maxPendingOrders: row.max_pending_orders,
    localEnabled: row.local_enabled,
    deliveryEnabled: row.delivery_enabled,
    onboardingCompleted: row.onboarding_completed,
    updatedAt: isoString(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function mapStorageError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (isUniqueViolation(error)) {
    throw new AppError(409, "restaurant_conflict", "Restaurant already exists");
  }
  throw new AppError(500, "internal_error", "Failed to persist restaurant");
}

export function createRestaurantRepository(database: Database): RestaurantRepository {
  return {
    async createOwnedRestaurant(userId, input) {
      try {
        return await withTransaction(database, async (client) => {
          const restaurantResult = await client.query<RestaurantRow>(
            `insert into public.restaurants (
              owner_id,
              name,
              slug,
              trial_ends_at,
              total_tables,
              max_tables,
              onboarding_completed,
              onboarding_completed_at
            ) values (
              $1::uuid,
              $2::text,
              $3::text,
              now() + interval '3 days',
              1,
              1,
              true,
              now()
            )
            returning ${RESTAURANT_COLUMNS}`,
            [userId, input.restaurantName, input.slug],
          );
          const restaurant = restaurantResult.rows[0];
          if (!restaurant) {
            throw new AppError(500, "internal_error", "Failed to persist restaurant");
          }

          await client.query(
            `insert into public.menu_items (
              restaurant_id,
              name,
              price
            ) values ($1::uuid, $2::text, $3::numeric)`,
            [restaurant.id, input.dishName, input.dishPrice],
          );

          return mapRestaurant(restaurant);
        });
      } catch (error) {
        mapStorageError(error);
      }
    },

    async findOwnedRestaurant(userId) {
      try {
        const result = await database.query<RestaurantRow>(
          `select ${RESTAURANT_COLUMNS}
          from public.restaurants
          where owner_id = $1::uuid
          limit 1`,
          [userId],
        );
        const row = result.rows[0];
        return row ? mapRestaurant(row) : null;
      } catch (error) {
        mapStorageError(error);
      }
    },

    async updateOwnedRestaurant(userId, patch) {
      const entries = Object.entries(patch) as Array<
        [keyof UpdateOwnedRestaurantBody, UpdateOwnedRestaurantBody[keyof UpdateOwnedRestaurantBody]]
      >;
      const assignments = entries.map(
        ([key], index) => `${PATCH_COLUMNS[key]} = $${index + 1}`,
      );
      const values = entries.map(([, value]) => value);
      values.push(userId);

      try {
        const result = await database.query<RestaurantRow>(
          `update public.restaurants
          set ${assignments.join(", ")}, updated_at = now()
          where owner_id = $${entries.length + 1}::uuid
          returning ${RESTAURANT_COLUMNS}`,
          values,
        );
        const row = result.rows[0];
        return row ? mapRestaurant(row) : null;
      } catch (error) {
        mapStorageError(error);
      }
    },
  };
}
