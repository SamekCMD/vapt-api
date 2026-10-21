import type { PoolClient } from "pg";
import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { RestaurantDto } from "../business/contracts.js";
import type { BillingPlanStatus, RestaurantScope, RestaurantWriteScope, TenantActor } from '../tenancy/contracts.js';
import { authorizeRestaurant, legacyWriteActor, resolveLegacyRestaurant, withRestaurantWrite } from '../tenancy/authorization.js';
import { lockSlugs } from '../tenancy/locks.js';
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
  plan_status: BillingPlanStatus;
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
  resolveLegacyRestaurant(userId:string):Promise<RestaurantScope>;
  getRestaurant(scope:RestaurantScope):Promise<RestaurantDto|null>;
  updateRestaurant(scope:RestaurantWriteScope,patch:UpdateOwnedRestaurantBody):Promise<RestaurantDto|null>;
  createOwnedRestaurant(userId: string, input: OnboardingBody): Promise<RestaurantDto>;
  findOwnedRestaurant(userId: string): Promise<RestaurantDto | null>;
  updateOwnedRestaurant(
    userId: string,
    patch: UpdateOwnedRestaurantBody,
    actor?:TenantActor,
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

const SCOPED_COLUMNS = RESTAURANT_COLUMNS.split(',').map(c=>c.trim()).filter(Boolean)
  .map(c=>`${['plan_type','plan_status','trial_ends_at'].includes(c)?'subscription':'restaurant'}.${c}`).join(',');

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

export function createRestaurantRepository(
  database: Database,
  options: { transaction?: PoolClient; onboardingRestaurantId?: string } = {},
): RestaurantRepository {
  const queryable = options.transaction ?? database;
  const repository:RestaurantRepository = {
    resolveLegacyRestaurant(userId) { return resolveLegacyRestaurant(queryable,userId); },
    async getRestaurant(scope) {
      try {
        await authorizeRestaurant(queryable,scope,'restaurant.read');
        const result = await queryable.query<RestaurantRow>(`select ${SCOPED_COLUMNS} from public.restaurants restaurant
          join public.organization_subscriptions subscription on subscription.organization_id=restaurant.organization_id
          join public.organization_members member on member.organization_id=restaurant.organization_id
          where restaurant.id=$1::uuid and member.user_id=$2::uuid and member.status='active'`,[scope.restaurantId,scope.userId]);
        return result.rows[0] ? mapRestaurant(result.rows[0]) : null;
      } catch(error) { mapStorageError(error); }
    },
    async updateRestaurant(scope,patch) {
      try {
        return await withRestaurantWrite(database,scope,'restaurant.manage',async client=> {
          const entries = Object.entries(patch) as [keyof UpdateOwnedRestaurantBody,unknown][];
          if (!entries.length || entries.some(([key])=>!Object.hasOwn(PATCH_COLUMNS,key))) {
            throw new AppError(400,'invalid_request','Invalid request');
          }
          const values = entries.map(([,value])=>value); values.push(scope.restaurantId,scope.userId);
          const n = entries.length;
          const result = await client.query<RestaurantRow>(`update public.restaurants restaurant
            set ${entries.map(([key],i)=>`${PATCH_COLUMNS[key]}=$${i+1}`).join(',')}
            from public.organization_subscriptions subscription
            where restaurant.id=$${n+1}::uuid and subscription.organization_id=restaurant.organization_id
              and exists(select 1 from public.organization_members member where member.organization_id=restaurant.organization_id
                and member.user_id=$${n+2}::uuid and member.status='active') returning ${SCOPED_COLUMNS}`,values);
          return result.rows[0] ? mapRestaurant(result.rows[0]) : null;
        },{ transaction:options.transaction, beforeSession: async client=> {
          if (patch.slug === undefined) return;
          const row = (await client.query<{ slug:string }>('select slug from public.restaurants where id=$1::uuid',[scope.restaurantId])).rows[0];
          await lockSlugs(client,[...(row?[row.slug]:[]),patch.slug]);
        } });
      } catch(error) { mapStorageError(error); }
    },
    async createOwnedRestaurant() {
      throw new AppError(410,'legacy_onboarding_retired','Use account onboarding drafts and explicit finalization');
    },

    async findOwnedRestaurant(userId) {
      try {
        return await repository.getRestaurant(await repository.resolveLegacyRestaurant(userId));
      } catch (error) {
        if (error instanceof AppError && error.statusCode===404) return null;
        mapStorageError(error);
      }
    },

    async updateOwnedRestaurant(userId, patch, actor) {
      const verified = legacyWriteActor(userId,actor);
      return repository.updateRestaurant({ ...verified,...await repository.resolveLegacyRestaurant(userId) },patch);
    },
  };
  return repository;
}
