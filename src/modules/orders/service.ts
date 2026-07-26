import { createHash, createHmac } from "node:crypto";

import { AppError } from "../../lib/errors.js";
import {
  OrderRepositoryError,
  type OrderRepository,
  type PublicOrderRecord,
} from "./repository.js";
import type { CreateOrderBody } from "./schemas.js";

export type CreatePublicOrderResponse = {
  orderId: string;
  displayId: number | null;
  restaurantId: string;
  tableSessionId: string | null;
  totalPrice: string;
  status: string;
  paymentStatus: string | null;
  publicToken: string;
  idempotentReplay: boolean;
};

export interface OrderService {
  createPublicOrder(body: CreateOrderBody, idempotencyKey: string): Promise<CreatePublicOrderResponse>;
  getPublicOrder(orderId: string, publicToken: string): Promise<PublicOrderRecord>;
}

function canonicalRequest(body: CreateOrderBody): string {
  return JSON.stringify({
    restaurantSlug: body.restaurantSlug,
    channel: body.channel,
    tableNumber: body.tableNumber ?? null,
    items: body.items.map((item) => ({
      menuItemId: item.menuItemId,
      variationId: item.variationId ?? null,
      quantity: item.quantity,
      notes: item.notes ?? null,
    })),
    delivery: body.delivery ?? null,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicToken(secret: string, requestFingerprint: string, idempotencyKey: string): string {
  return createHmac("sha256", secret)
    .update(`public-order:${requestFingerprint}:${idempotencyKey}`)
    .digest("base64url");
}

function mapRepositoryError(error: OrderRepositoryError): never {
  if (error.code === "restaurant_not_found") {
    throw new AppError(404, "not_found", "Restaurant not found");
  }
  if (error.code === "channel_unavailable") {
    throw new AppError(409, "channel_unavailable", "Order channel is unavailable");
  }
  if (error.code === "item_unavailable") {
    throw new AppError(409, "item_unavailable", "One or more items are unavailable");
  }
  if (error.code === "idempotency_conflict") {
    throw new AppError(409, "idempotency_conflict", "Idempotency key was reused with another order");
  }
  throw new AppError(400, "invalid_request", "Invalid order");
}

export function createOrderService(repository: OrderRepository, tokenSecret: string): OrderService {
  return {
    async createPublicOrder(body, idempotencyKey) {
      const requestFingerprint = sha256(canonicalRequest(body));
      const token = publicToken(tokenSecret, requestFingerprint, idempotencyKey);

      try {
        const order = await repository.createPublicOrder({
          ...body,
          idempotencyKey,
          requestFingerprint,
          publicTokenHash: sha256(token),
        });
        return { ...order, publicToken: token };
      } catch (error) {
        if (error instanceof OrderRepositoryError) mapRepositoryError(error);
        throw error;
      }
    },

    async getPublicOrder(orderId, token) {
      const order = await repository.findPublicOrder(orderId, sha256(token));
      if (!order) throw new AppError(404, "not_found", "Order not found");
      return order;
    },
  };
}
