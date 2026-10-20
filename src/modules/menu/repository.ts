import type { PoolClient } from "pg";
import type { Database, Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { MenuItemDto, MenuVariationDto } from "../business/contracts.js";
import type { RestaurantScope, RestaurantWriteScope, TenantActor } from "../tenancy/contracts.js";
import { authorizeRestaurant, legacyWriteActor, resolveLegacyRestaurant, withRestaurantWrite } from "../tenancy/authorization.js";
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
  resolveLegacyRestaurant(userId:string):Promise<RestaurantScope>;
  listMenuItems(scope:RestaurantScope):Promise<MenuItemDto[]>;
  createMenuItem(scope:RestaurantWriteScope,input:CreateMenuItemBody):Promise<MenuItemDto|null>;
  updateMenuItem(scope:RestaurantWriteScope,itemId:string,patch:UpdateMenuItemBody):Promise<MenuItemDto|null>;
  deleteMenuItem(scope:RestaurantWriteScope,itemId:string):Promise<boolean>;
  listOwnedMenuItems(userId:string):Promise<MenuItemDto[]>;
  createOwnedMenuItem(userId:string,input:CreateMenuItemBody,actor?:TenantActor):Promise<MenuItemDto|null>;
  updateOwnedMenuItem(userId:string,itemId:string,patch:UpdateMenuItemBody,actor?:TenantActor):Promise<MenuItemDto|null>;
  deleteOwnedMenuItem(userId:string,itemId:string,actor?:TenantActor):Promise<boolean>;
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

const ACTIVE_MEMBER = `exists(select 1 from public.restaurants restaurant
  join public.organization_members member on member.organization_id=restaurant.organization_id
  where restaurant.id=item.restaurant_id and member.user_id=$3::uuid and member.status='active')`;

async function loadItem(q:Queryable,scope:RestaurantScope,itemId:string):Promise<MenuItemDto|null> {
  const result=await q.query<MenuItemRow>(`select ${ITEM_SELECT} from public.menu_items item
    left join public.menu_item_variations variation on variation.menu_item_id=item.id
    where item.id=$1::uuid and item.restaurant_id=$2::uuid and ${ACTIVE_MEMBER}
    group by item.id`,[itemId,scope.restaurantId,scope.userId]);
  return result.rows[0]?mapMenuItem(result.rows[0]):null;
}
async function insertVariations(q:Queryable,scope:RestaurantScope,itemId:string,variations:MenuVariationInput[]) {
  for (const variation of variations) {
    const result=await q.query(`insert into public.menu_item_variations (menu_item_id,name,options,required)
      select id,$3::text,$4::text[],$5::boolean from public.menu_items
      where id=$1::uuid and restaurant_id=$2::uuid`,
    [itemId,scope.restaurantId,variation.name,variation.options,variation.required]);
    if(result.rowCount!==1) throw storageFailure();
  }
}
export function createMenuRepository(database:Database,options:{ transaction?:PoolClient }={}):MenuRepository {
  const q=options.transaction??database;
  const guarded=async<T>(scope:RestaurantWriteScope,work:(client:PoolClient)=>Promise<T>)=>{
    try { return await withRestaurantWrite(database,scope,'restaurant.manage',work,options); }
    catch(error) { if(error instanceof AppError) throw error; throw storageFailure(); }
  };
  const repository:MenuRepository={
    resolveLegacyRestaurant(userId) { return resolveLegacyRestaurant(q,userId); },
    async listMenuItems(scope) {
      try {
        await authorizeRestaurant(q,scope,'restaurant.read');
        const result=await q.query<MenuItemRow>(`select ${ITEM_SELECT} from public.menu_items item
          left join public.menu_item_variations variation on variation.menu_item_id=item.id
          where item.restaurant_id=$1::uuid and exists(select 1 from public.restaurants restaurant
            join public.organization_members member on member.organization_id=restaurant.organization_id
            where restaurant.id=item.restaurant_id and member.user_id=$2::uuid and member.status='active')
          group by item.id order by item.created_at desc,item.id desc`,[scope.restaurantId,scope.userId]);
        return result.rows.map(mapMenuItem);
      } catch(error) { if(error instanceof AppError) throw error; throw storageFailure(); }
    },
    async createMenuItem(scope,input) {
      return guarded(scope,async client=>{
        if(input.isChefSuggestion) await client.query(`update public.menu_items set is_chef_suggestion=false,updated_at=now()
          where restaurant_id=$1::uuid and is_chef_suggestion=true`,[scope.restaurantId]);
        const result=await client.query<{id:string}>(`insert into public.menu_items
          (restaurant_id,name,price,description,category,available,image_url,available_from,available_until,badge,is_chef_suggestion,prep_time_minutes)
          values($1::uuid,$2::text,$3::numeric,$4::text,$5::text,$6::boolean,$7::text,$8::text,$9::text,$10::text,$11::boolean,$12::integer)
          returning id`,[scope.restaurantId,input.name,input.price,input.description,input.category,input.available,
          input.imageUrl,input.availableFrom,input.availableUntil,input.badge,input.isChefSuggestion,input.prepTimeMinutes]);
        const item=result.rows[0]; if(!item) throw storageFailure();
        await insertVariations(client,scope,item.id,input.variations);
        const created=await loadItem(client,scope,item.id); if(!created) throw storageFailure(); return created;
      });
    },
    async updateMenuItem(scope,itemId,patch) {
      return guarded(scope,async client=>{
        const found=await client.query(`select id from public.menu_items
          where id=$1::uuid and restaurant_id=$2::uuid for update`,[itemId,scope.restaurantId]);
        if(!found.rows[0]) return null;
        if(patch.isChefSuggestion===true) await client.query(`update public.menu_items
          set is_chef_suggestion=false,updated_at=now() where restaurant_id=$1::uuid and id<>$2::uuid and is_chef_suggestion=true`,
        [scope.restaurantId,itemId]);
        const entries=Object.entries(patch).filter(([key])=>key!=='variations') as [keyof typeof PATCH_COLUMNS,unknown][];
        if(entries.some(([key])=>!Object.hasOwn(PATCH_COLUMNS,key))) throw new AppError(400,'invalid_request','Invalid request');
        const n=entries.length, values=entries.map(([,value])=>value);
        values.push(itemId,scope.restaurantId,scope.userId);
        const assignments=entries.map(([key],i)=>`${PATCH_COLUMNS[key]}=$${i+1}`);
        await client.query(`update public.menu_items item set ${[...assignments,'updated_at=now()'].join(',')}
          where item.id=$${n+1}::uuid and item.restaurant_id=$${n+2}::uuid
          and exists(select 1 from public.restaurants restaurant
            join public.organization_members member on member.organization_id=restaurant.organization_id
            where restaurant.id=item.restaurant_id and member.user_id=$${n+3}::uuid and member.status='active')`,values);
        if(patch.variations!==undefined) {
          await client.query(`delete from public.menu_item_variations variation using public.menu_items item
            where variation.menu_item_id=item.id and item.id=$1::uuid and item.restaurant_id=$2::uuid`,[itemId,scope.restaurantId]);
          await insertVariations(client,scope,itemId,patch.variations);
        }
        const updated=await loadItem(client,scope,itemId); if(!updated) throw storageFailure(); return updated;
      });
    },
    async deleteMenuItem(scope,itemId) {
      return guarded(scope,async client=>{
        const result=await client.query(`delete from public.menu_items item
          where item.id=$1::uuid and item.restaurant_id=$2::uuid and ${ACTIVE_MEMBER} returning item.id`,
        [itemId,scope.restaurantId,scope.userId]);
        return Boolean(result.rows[0]);
      });
    },
    async listOwnedMenuItems(userId) { return repository.listMenuItems(await repository.resolveLegacyRestaurant(userId)); },
    async createOwnedMenuItem(userId,input,actor) {
      const verified=legacyWriteActor(userId,actor);
      return repository.createMenuItem({...verified,...await repository.resolveLegacyRestaurant(userId)},input);
    },
    async updateOwnedMenuItem(userId,itemId,patch,actor) {
      const verified=legacyWriteActor(userId,actor);
      return repository.updateMenuItem({...verified,...await repository.resolveLegacyRestaurant(userId)},itemId,patch);
    },
    async deleteOwnedMenuItem(userId,itemId,actor) {
      const verified=legacyWriteActor(userId,actor);
      return repository.deleteMenuItem({...verified,...await repository.resolveLegacyRestaurant(userId)},itemId);
    },
  };
  return repository;
}
