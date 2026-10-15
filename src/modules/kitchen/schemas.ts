import { z } from "zod";

export const kitchenOrderParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const updateKitchenOrderStatusBodySchema = z.object({
  status: z.enum(["preparing", "ready", "delivered"]),
}).strict();

export type KitchenOrderTargetStatus = z.infer<
  typeof updateKitchenOrderStatusBodySchema
>["status"];
