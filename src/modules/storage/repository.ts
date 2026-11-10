import type { Database,Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { RestaurantWriteScope } from '../tenancy/contracts.js';
import { authorizeRestaurant,withRestaurantWrite } from '../tenancy/authorization.js';

export type MenuItemExists = (input: {
  userId: string;
  restaurantId: string;
  itemId: string;
}) => Promise<boolean>;

export function createMenuItemExists(database: Queryable): MenuItemExists {
  return async ({ userId, restaurantId, itemId }) => {
    try {
      await authorizeRestaurant(database,{ userId,restaurantId },'restaurant.manage');
      const result = await database.query<{ exists: boolean }>(
        `select exists (
          select 1
          from public.menu_items as item
          join public.restaurants as restaurant on restaurant.id = item.restaurant_id
          where item.id = $1::uuid
            and restaurant.id = $2::uuid
            and exists(select 1 from public.organization_members member where member.organization_id=restaurant.organization_id
              and member.user_id=$3::uuid and member.status='active')
        ) as exists`,
        [itemId, restaurantId, userId],
      );
      return result.rows[0]?.exists === true;
    } catch(error) {
      if(error instanceof AppError) throw error;
      throw new AppError(500, "internal_error", "Failed to verify menu item");
    }
  };
}

export type WithAuthorizedMenuItem=<T>(scope:RestaurantWriteScope & { itemId:string },work:()=>Promise<T>)=>Promise<T>;
export function createMenuImageAccess(database:Database):WithAuthorizedMenuItem {
  return async(scope,work)=>{
    try {
      return await withRestaurantWrite(database,scope,'restaurant.manage',async client=>{
        const found=await client.query(`select id from public.menu_items where id=$1::uuid and restaurant_id=$2::uuid for share`,[scope.itemId,scope.restaurantId]);
        if(!found.rows[0]) throw new AppError(404,'menu_item_not_found','Menu item not found');
        return work();
      });
    } catch(error) {
      if(error instanceof AppError) throw error;
      throw new AppError(500,'internal_error','Failed to authorize menu image operation');
    }
  };
}
