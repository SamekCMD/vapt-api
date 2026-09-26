import { AppError } from "../../lib/errors.js";
import type { KitchenRepository } from "./repository.js";
import type { KitchenOrderTargetStatus } from "./schemas.js";

const NEXT_STATUS: Record<string, KitchenOrderTargetStatus | undefined> = {
  paid: "preparing",
  pending: "preparing",
  preparing: "ready",
  ready: "delivered",
};

export function createKitchenService(repository: KitchenRepository) {
  return {
    listActiveOwnedOrders(userId: string) {
      return repository.listActiveOwnedOrders(userId);
    },

    async updateOwnedOrderStatus(
      userId: string,
      orderId: string,
      target: KitchenOrderTargetStatus,
    ) {
      const order = await repository.updateOwnedOrderStatus(
        userId,
        orderId,
        target,
        (current) => {
          if (current === target) return;
          if (NEXT_STATUS[current] !== target) {
            throw new AppError(
              409,
              "invalid_order_transition",
              "Order status transition is not allowed",
            );
          }
        },
      );
      if (!order) throw new AppError(404, "order_not_found", "Order not found");
      return order;
    },
  };
}
