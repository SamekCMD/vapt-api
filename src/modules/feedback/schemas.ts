import { z } from "zod";

export const feedbackParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const feedbackBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  reasons: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  comment: z.string().trim().max(500).nullable().default(null),
}).strict();

export type FeedbackBody = z.infer<typeof feedbackBodySchema>;
