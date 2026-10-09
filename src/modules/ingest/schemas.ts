import { z } from "zod";

export const orderFeedbackBodySchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  reasons: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  comment: z.string().trim().max(500).nullable().default(null),
  created_at: z.string().trim().min(1).optional(),
}).strict();

export const pushSubscriptionBodySchema = z.object({
  subscription: z.record(z.string(), z.unknown()),
  endpoint: z.string().trim().url().max(4096),
  origin: z.string().trim().url().max(2048),
  user_agent: z.string().trim().min(1).max(1024),
}).strict();

export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBodySchema>;
