import { z } from "zod";
import { restaurantParamsSchema } from '../restaurants/schemas.js';

export const scopedTableSessionParamsSchema = restaurantParamsSchema.extend({ sessionId:z.string().uuid() });

export const tableSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

export const transferTableSessionBodySchema = z.object({
  tableNumber: z.string().trim().min(1).max(20),
}).strict();

export const requestCheckTableSessionBodySchema = z.object({
  publicOrderId: z.string().uuid(),
  publicOrderToken: z.string().trim().min(32).max(256),
}).strict();

export type TransferTableSessionBody = z.infer<typeof transferTableSessionBodySchema>;
