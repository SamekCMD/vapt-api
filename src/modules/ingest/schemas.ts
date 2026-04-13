import { z } from "zod";

export const orderFeedbackBodySchema = z.object({
  order_id: z.string().trim().min(1),
  restaurant_id: z.string().trim().min(1),
  rating: z.number().finite(),
  reasons: z.array(z.string().trim()).default([]),
  comment: z.string().trim().nullable().optional(),
  created_at: z.string().trim().min(1),
});

export const pushSubscriptionBodySchema = z.object({
  restaurant_id: z.string().trim().min(1),
  subscription: z.unknown(),
  endpoint: z.string().trim().min(1),
  origin: z.string().trim().min(1),
  user_agent: z.string().trim().min(1),
  created_at: z.string().trim().min(1),
});
