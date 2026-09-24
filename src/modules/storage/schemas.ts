import { z } from "zod";

export const menuImageParamsSchema = z.object({
  restaurantId: z.string().uuid(),
  itemId: z.string().uuid(),
}).strict();

export const prepareMenuImageUploadBodySchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentLength: z.number().int().positive().max(5 * 1024 * 1024),
}).strict();
