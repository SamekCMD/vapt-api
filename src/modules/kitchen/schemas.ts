import { z } from "zod";
import { restaurantParamsSchema } from '../restaurants/schemas.js';

export const kitchenOrderParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const scopedKitchenOrderParamsSchema=restaurantParamsSchema.extend({ orderId:z.string().uuid().transform(id=>id.toLowerCase()) });

export const updateKitchenOrderStatusBodySchema = z.object({
  status: z.enum(["preparing", "ready", "delivered"]),
}).strict();

export type KitchenOrderTargetStatus = z.infer<
  typeof updateKitchenOrderStatusBodySchema
>["status"];
