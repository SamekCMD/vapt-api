import type { Database, Queryable } from "../../lib/database.js";
import { withTransaction } from "../../lib/database.js";
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
  listActiveOwnedOrders(userId: string): Promise<KitchenOrderDto[]>;
  updateOwnedOrderStatus(
    userId: string,
    orderId: string,
    target: KitchenOrderTargetStatus,
    validateCurrent: (currentStatus: string) => void,
  ): Promise<KitchenOrderDto | null>;
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

async function loadOwnedOrder(
  queryable: Queryable,
  userId: string,
  orderId: string,
): Promise<KitchenOrderDto | null> {
  const result = await queryable.query<KitchenOrderRow>(
    `select ${ORDER_SELECT}
    from public.orders as order_row
    join public.restaurants as restaurant
      on restaurant.id = order_row.restaurant_id
    left join public.order_items as order_item
      on order_item.order_id = order_row.id
    where order_row.id = $1::uuid
      and restaurant.owner_id = $2::uuid
    group by order_row.id
    limit 1`,
    [orderId, userId],
  );
  const row = result.rows[0];
  return row ? mapOrder(row) : null;
}

export function createKitchenRepository(database: Database): KitchenRepository {
  return {
    async listActiveOwnedOrders(userId) {
      try {
        const result = await database.query<KitchenOrderRow>(
          `select ${ORDER_SELECT}
          from public.orders as order_row
          join public.restaurants as restaurant
            on restaurant.id = order_row.restaurant_id
          left join public.order_items as order_item
            on order_item.order_id = order_row.id
          where restaurant.owner_id = $1::uuid
            and order_row.status in ('paid', 'pending', 'preparing', 'ready')
          group by order_row.id
          order by order_row.created_at desc, order_row.id desc`,
          [userId],
        );
        return result.rows.map(mapOrder);
      } catch {
        throw storageFailure();
      }
    },

    async updateOwnedOrderStatus(userId, orderId, target, validateCurrent) {
      try {
        return await withTransaction(database, async (client) => {
          const locked = await client.query<{ status: string }>(
            `select order_row.status
            from public.orders as order_row
            join public.restaurants as restaurant
              on restaurant.id = order_row.restaurant_id
            where order_row.id = $1::uuid
              and restaurant.owner_id = $2::uuid
            for update of order_row, restaurant`,
            [orderId, userId],
          );
          const current = locked.rows[0];
          if (!current) return null;

          validateCurrent(current.status);
          if (current.status !== target) {
            await client.query(
              `update public.orders as order_row
              set status = $1::text,
                  updated_at = now()
              from public.restaurants as restaurant
              where order_row.id = $2::uuid
                and restaurant.id = order_row.restaurant_id
                and restaurant.owner_id = $3::uuid`,
              [target, orderId, userId],
            );
          }

          const updated = await loadOwnedOrder(client, userId, orderId);
          if (!updated) throw storageFailure();
          return updated;
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageFailure();
      }
    },
  };
}
