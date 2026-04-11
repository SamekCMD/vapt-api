import { z } from "zod";

export const restaurantAccessParamsSchema = z.object({
  restaurantId: z.string().trim().min(1),
});
