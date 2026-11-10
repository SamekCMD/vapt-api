import type { Database, Queryable } from "../../lib/database.js";
import type { RestaurantScope,RestaurantWriteScope,TenantActor } from '../tenancy/contracts.js';
import { authorizeRestaurant,legacyWriteActor,resolveLegacyRestaurant,withRestaurantWrite } from '../tenancy/authorization.js';
import { emitCommittedChange, requireManagedObserverPool, type CommittedChangeOptions } from "../realtime/committed-changes.js";
import type { CommittedChange } from "../realtime/contracts.js";
import { AppError } from "../../lib/errors.js";
import type {
  KitchenOrderDto,
  KitchenOrderItemDto,
  KitchenOrderStatus,
} from "../business/contracts.js";
import type { KitchenOrderTargetStatus } from "./schemas.js";

type KitchenOrderRow = {
  id: string;
  display_id: string | number | null;
  restaurant_id: string;
  table_number: string | null;
  total_price: string | number;
  status: KitchenOrderStatus;
  payment_status: string | null;
  order_channel: "local" | "delivery";
  created_at: string | Date;
  updated_at: string | Date;
  items: KitchenOrderItemDto[] | null;
};

export interface KitchenRepository {
  resolveLegacyRestaurant(userId:string):Promise<RestaurantScope>;
  listActiveOrders(scope:RestaurantScope):Promise<KitchenOrderDto[]>;
  updateOrderStatus(scope:RestaurantWriteScope,orderId:string,target:KitchenOrderTargetStatus,validateCurrent:(status:string)=>void):Promise<KitchenOrderDto|null>;
  listActiveOwnedOrders(userId:string):Promise<KitchenOrderDto[]>;
  updateOwnedOrderStatus(userId:string,orderId:string,target:KitchenOrderTargetStatus,validateCurrent:(status:string)=>void,actor?:TenantActor):Promise<KitchenOrderDto|null>;
}

const ORDER_SELECT = `
  order_row.id,
  order_row.display_id,
  order_row.restaurant_id,
  order_row.table_number,
  order_row.total_price,
  order_row.status,
  order_row.payment_status,
  order_row.order_channel,
  order_row.created_at,
  order_row.updated_at,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', order_item.id,
        'productName', order_item.product_name,
        'quantity', order_item.quantity,
        'unitPrice', order_item.unit_price::text,
        'notes', order_item.notes
      )
      order by order_item.created_at asc, order_item.id asc
    ) filter (where order_item.id is not null),
    '[]'::jsonb
  ) as items
`;

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function mapOrder(row: KitchenOrderRow): KitchenOrderDto {
  return {
    id: row.id,
    displayId: row.display_id === null ? null : String(row.display_id),
    restaurantId: row.restaurant_id,
    tableNumber: row.table_number,
    totalPrice: decimalString(row.total_price),
    status: row.status,
    channel: row.order_channel,
    paymentStatus: row.payment_status,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    items: Array.isArray(row.items) ? row.items : [],
  };
}

function storageFailure(): AppError {
  return new AppError(500, "internal_error", "Failed to persist kitchen data");
}

const ACTIVE_MEMBER=`exists(select 1 from public.restaurants restaurant
  join public.organization_members member on member.organization_id=restaurant.organization_id
  where restaurant.id=order_row.restaurant_id and member.user_id=$3::uuid and member.status='active')`;
async function loadOrder(q:Queryable,scope:RestaurantScope,orderId:string):Promise<KitchenOrderDto|null> {
  const result=await q.query<KitchenOrderRow>(`select ${ORDER_SELECT} from public.orders order_row
    left join public.order_items order_item on order_item.order_id=order_row.id
    where order_row.id=$1::uuid and order_row.restaurant_id=$2::uuid and ${ACTIVE_MEMBER}
    group by order_row.id`,[orderId,scope.restaurantId,scope.userId]);
  return result.rows[0]?mapOrder(result.rows[0]):null;
}
export function createKitchenRepository(database:Database,options:CommittedChangeOptions={}):KitchenRepository {
  requireManagedObserverPool(database,options);
  const repository:KitchenRepository={
    resolveLegacyRestaurant(userId){ return resolveLegacyRestaurant(database,userId); },
    async listActiveOrders(scope) {
      try {
        await authorizeRestaurant(database,scope,'restaurant.read');
        const result=await database.query<KitchenOrderRow>(`select ${ORDER_SELECT} from public.orders order_row
          left join public.order_items order_item on order_item.order_id=order_row.id
          where order_row.restaurant_id=$1::uuid and order_row.status in ('paid','pending','preparing','ready')
            and exists(select 1 from public.restaurants restaurant
              join public.organization_members member on member.organization_id=restaurant.organization_id
              where restaurant.id=order_row.restaurant_id and member.user_id=$2::uuid and member.status='active')
          group by order_row.id order by order_row.created_at desc,order_row.id desc`,[scope.restaurantId,scope.userId]);
        return result.rows.map(mapOrder);
      } catch(error) { if(error instanceof AppError) throw error; throw storageFailure(); }
    },
    async updateOrderStatus(scope,orderId,target,validateCurrent) {
      try {
        let change:CommittedChange|undefined;
        const result=await withRestaurantWrite(database,scope,'restaurant.operate',async client=>{
          const locked=await client.query<{status:string}>(`select order_row.status from public.orders order_row
            where order_row.id=$1::uuid and order_row.restaurant_id=$2::uuid and ${ACTIVE_MEMBER}
            for update of order_row`,[orderId,scope.restaurantId,scope.userId]);
          const current=locked.rows[0]; if(!current) return null;
          validateCurrent(current.status);
          if(current.status!==target) await client.query(`update public.orders order_row set status=$1::text,updated_at=now()
            where order_row.id=$2::uuid and order_row.restaurant_id=$3::uuid
              and exists(select 1 from public.restaurants restaurant
                join public.organization_members member on member.organization_id=restaurant.organization_id
                where restaurant.id=order_row.restaurant_id and member.user_id=$4::uuid and member.status='active')`,
          [target,orderId,scope.restaurantId,scope.userId]);
          const updated=await loadOrder(client,scope,orderId); if(!updated) throw storageFailure();
          if(updated.status!==current.status) change={ restaurantId:scope.restaurantId,
            topics:['orders','kitchen','table_sessions'],orderIds:[updated.id],entityId:updated.id,reason:'updated' };
          return updated;
        });
        await emitCommittedChange(options,change); return result;
      } catch(error) { if(error instanceof AppError) throw error; throw storageFailure(); }
    },
    async listActiveOwnedOrders(userId) { return repository.listActiveOrders(await repository.resolveLegacyRestaurant(userId)); },
    async updateOwnedOrderStatus(userId,orderId,target,validateCurrent,actor) {
      const verified=legacyWriteActor(userId,actor);
      return repository.updateOrderStatus({...verified,...await repository.resolveLegacyRestaurant(userId)},orderId,target,validateCurrent);
    },
  };
  return repository;
}
