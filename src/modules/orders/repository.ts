import type { SupabaseClient } from "@supabase/supabase-js";

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
  displayId: number | null;
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
  display_id: number | null;
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
  display_id: number | null;
  restaurant_id: string;
  table_session_id: string | null;
  table_number: string | null;
  total_price: string | number;
  status: string;
  payment_status: string | null;
  order_channel: "local" | "delivery";
  created_at: string;
  order_items: RawOrderItem[] | null;
};

const ORDER_ERROR_CODES = new Set<OrderRepositoryErrorCode>([
  "restaurant_not_found",
  "channel_unavailable",
  "item_unavailable",
  "item_restaurant_mismatch",
  "invalid_order",
  "idempotency_conflict",
]);

function mapCreateOrder(row: RawCreateOrder): CreatePublicOrderRecord {
  return {
    orderId: row.order_id,
    displayId: row.display_id,
    restaurantId: row.restaurant_id,
    tableSessionId: row.table_session_id,
    totalPrice: Number(row.total_price).toFixed(2),
    status: row.status,
    paymentStatus: row.payment_status,
    idempotentReplay: row.idempotent_replay,
  };
}

type PostgrestFailure = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

function diagnosticText(value: string | null | undefined): string | null {
  return value?.trim().slice(0, 2_000) || null;
}

function mapRepositoryError(error: PostgrestFailure): never {
  const message = error.message?.trim() ?? "";
  if (ORDER_ERROR_CODES.has(message as OrderRepositoryErrorCode)) {
    throw new OrderRepositoryError(message as OrderRepositoryErrorCode);
  }
  throw new AppError(500, "order_storage_error", "Failed to persist order", {
    provider: "postgrest",
    code: diagnosticText(error.code),
    message: diagnosticText(error.message),
    details: diagnosticText(error.details),
    hint: diagnosticText(error.hint),
  });
}

export function createOrderRepository(client: SupabaseClient): OrderRepository {
  return {
    async createPublicOrder(input) {
      const result = await client.rpc("create_public_order_v3", {
        p_restaurant_slug: input.restaurantSlug,
        p_channel: input.channel,
        p_table_number: input.tableNumber ?? null,
        p_items: input.items,
        p_delivery: input.delivery ?? null,
        p_public_token_hash: input.publicTokenHash,
        p_idempotency_key: input.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
      }).single<RawCreateOrder>();

      if (result.error) mapRepositoryError(result.error);
      return mapCreateOrder(result.data);
    },

    async findPublicOrder(orderId, tokenHash) {
      const result = await client
        .from("orders")
        .select("id, display_id, restaurant_id, table_session_id, table_number, total_price, status, payment_status, order_channel, created_at, order_items(product_id, product_name, quantity, unit_price, notes)")
        .eq("id", orderId)
        .eq("public_access_token_hash", tokenHash)
        .maybeSingle<RawPublicOrder>();

      if (result.error) {
        throw new AppError(500, "order_storage_error", "Failed to load order");
      }
      if (!result.data) return null;

      return {
        orderId: result.data.id,
        displayId: result.data.display_id,
        restaurantId: result.data.restaurant_id,
        tableSessionId: result.data.table_session_id,
        tableNumber: result.data.table_number,
        totalPrice: Number(result.data.total_price).toFixed(2),
        status: result.data.status,
        paymentStatus: result.data.payment_status,
        idempotentReplay: false,
        channel: result.data.order_channel,
        createdAt: result.data.created_at,
        items: (result.data.order_items ?? []).map((item) => ({
          menuItemId: item.product_id,
          name: item.product_name,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price).toFixed(2),
          notes: item.notes,
        })),
      };
    },
  };
}
