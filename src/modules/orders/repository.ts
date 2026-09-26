import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { CreateOrderBody } from "./schemas.js";

export type OrderRepositoryErrorCode =
  | "restaurant_not_found"
  | "channel_unavailable"
  | "item_unavailable"
  | "item_restaurant_mismatch"
  | "invalid_order"
  | "idempotency_conflict";

export class OrderRepositoryError extends Error {
  constructor(public readonly code: OrderRepositoryErrorCode) {
    super(code);
    this.name = "OrderRepositoryError";
  }
}

export type CreatePublicOrderInput = CreateOrderBody & {
  idempotencyKey: string;
  requestFingerprint: string;
  publicTokenHash: string;
};

export type CreatePublicOrderRecord = {
  orderId: string;
  displayId: string | null;
  restaurantId: string;
  tableSessionId: string | null;
  totalPrice: string;
  status: string;
  paymentStatus: string | null;
  idempotentReplay: boolean;
};

export type PublicOrderItemRecord = {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  notes: string | null;
};

export type PublicOrderRecord = CreatePublicOrderRecord & {
  channel: "local" | "delivery";
  tableNumber: string | null;
  createdAt: string;
  items: PublicOrderItemRecord[];
};

export interface OrderRepository {
  createPublicOrder(input: CreatePublicOrderInput): Promise<CreatePublicOrderRecord>;
  findPublicOrder(orderId: string, tokenHash: string): Promise<PublicOrderRecord | null>;
}

type RawCreateOrder = {
  order_id: string;
  display_id: string | number | null;
  restaurant_id: string;
  table_session_id: string | null;
  total_price: string | number;
  status: string;
  payment_status: string | null;
  idempotent_replay: boolean;
};

type RawOrderItem = {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: string | number;
  notes: string | null;
};

type RawPublicOrder = {
  id: string;
  display_id: string | number | null;
  restaurant_id: string;
  table_session_id: string | null;
  table_number: string | null;
  total_price: string | number;
  status: string;
  payment_status: string | null;
  order_channel: "local" | "delivery";
  created_at: string | Date;
};

const ORDER_ERROR_CODES = new Set<OrderRepositoryErrorCode>([
  "restaurant_not_found",
  "channel_unavailable",
  "item_unavailable",
  "item_restaurant_mismatch",
  "invalid_order",
  "idempotency_conflict",
]);

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function bigintString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapCreateOrder(row: RawCreateOrder): CreatePublicOrderRecord {
  return {
    orderId: row.order_id,
    displayId: bigintString(row.display_id),
    restaurantId: row.restaurant_id,
    tableSessionId: row.table_session_id,
    totalPrice: decimalString(row.total_price),
    status: row.status,
    paymentStatus: row.payment_status,
    idempotentReplay: row.idempotent_replay,
  };
}

function mapCreateFailure(error: unknown): never {
  const message = error instanceof Error ? error.message.trim() : "";
  if (ORDER_ERROR_CODES.has(message as OrderRepositoryErrorCode)) {
    throw new OrderRepositoryError(message as OrderRepositoryErrorCode);
  }
  throw new AppError(500, "order_storage_error", "Failed to persist order");
}

export function createOrderRepository(database: Queryable): OrderRepository {
  return {
    async createPublicOrder(input) {
      let result;
      try {
        result = await database.query<RawCreateOrder>(
          `select * from public.create_public_order_v3(
            $1::text,
            $2::text,
            $3::integer,
            $4::jsonb,
            $5::jsonb,
            $6::text,
            $7::text,
            $8::text
          )`,
          [
            input.restaurantSlug,
            input.channel,
            input.tableNumber ?? null,
            input.items,
            input.delivery ?? null,
            input.publicTokenHash,
            input.idempotencyKey,
            input.requestFingerprint,
          ],
        );
      } catch (error) {
        mapCreateFailure(error);
      }

      const row = result.rows[0];
      if (!row) {
        throw new AppError(500, "order_storage_error", "Failed to persist order");
      }
      return mapCreateOrder(row);
    },

    async findPublicOrder(orderId, tokenHash) {
      let orderResult;
      try {
        orderResult = await database.query<RawPublicOrder>(
          `select
            id,
            display_id,
            restaurant_id,
            table_session_id,
            table_number,
            total_price,
            status,
            payment_status,
            order_channel,
            created_at
          from public.orders
          where id = $1::uuid
            and public_access_token_hash = $2::text
          limit 1`,
          [orderId, tokenHash],
        );
      } catch {
        throw new AppError(500, "order_storage_error", "Failed to load order");
      }

      const order = orderResult.rows[0];
      if (!order) return null;

      let itemResult;
      try {
        itemResult = await database.query<RawOrderItem>(
          `select product_id, product_name, quantity, unit_price, notes
          from public.order_items
          where order_id = $1::uuid
          order by created_at, id`,
          [orderId],
        );
      } catch {
        throw new AppError(500, "order_storage_error", "Failed to load order");
      }

      return {
        orderId: order.id,
        displayId: bigintString(order.display_id),
        restaurantId: order.restaurant_id,
        tableSessionId: order.table_session_id,
        tableNumber: order.table_number,
        totalPrice: decimalString(order.total_price),
        status: order.status,
        paymentStatus: order.payment_status,
        idempotentReplay: false,
        channel: order.order_channel,
        createdAt: isoString(order.created_at),
        items: itemResult.rows.map((item) => ({
          menuItemId: item.product_id,
          name: item.product_name,
          quantity: item.quantity,
          unitPrice: decimalString(item.unit_price),
          notes: item.notes,
        })),
      };
    },
  };
}
