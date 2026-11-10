import { AppError } from "../../lib/errors.js";
import type { RestaurantScope,RestaurantWriteScope,TenantActor } from '../tenancy/contracts.js';
import type { KitchenRepository } from "./repository.js";
import type { KitchenOrderTargetStatus } from "./schemas.js";

const NEXT_STATUS: Record<string, KitchenOrderTargetStatus | undefined> = {
  paid: "preparing",
  pending: "preparing",
  preparing: "ready",
  ready: "delivered",
};

export function createKitchenService(repository: KitchenRepository) {
  const validateCurrent=(target:KitchenOrderTargetStatus)=>(current:string)=>{
    if(current!==target && NEXT_STATUS[current]!==target) throw new AppError(409,'invalid_order_transition','Order status transition is not allowed');
  };
  return {
    listActiveOrders(scope:RestaurantScope){ return repository.listActiveOrders(scope); },
    async updateOrderStatus(scope:RestaurantWriteScope,orderId:string,target:KitchenOrderTargetStatus){
      const order=await repository.updateOrderStatus(scope,orderId,target,validateCurrent(target));
      if(!order) throw new AppError(404,'order_not_found','Order not found'); return order;
    },
    listActiveOwnedOrders(userId: string) {
      return repository.listActiveOwnedOrders(userId);
    },

    async updateOwnedOrderStatus(
      userId: string,
      orderId: string,
      target: KitchenOrderTargetStatus,
      actor?:TenantActor,
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
        actor,
      );
      if (!order) throw new AppError(404, "order_not_found", "Order not found");
      return order;
    },
  };
}
