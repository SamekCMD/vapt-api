import { z } from "zod";

export const catalogParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
}).strict();
