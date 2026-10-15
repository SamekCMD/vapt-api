import { z } from "zod";
import { MENU_IMAGE_MAX_BYTES } from "./policy.js";

export const menuImageParamsSchema = z.object({
  restaurantId: z.string().uuid(),
  itemId: z.string().uuid(),
}).strict();

export const prepareMenuImageUploadBodySchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  contentLength: z.number().int().positive().max(MENU_IMAGE_MAX_BYTES),
}).strict();
