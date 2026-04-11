import { z } from "zod";

export const stripeCheckoutBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  email: z.string().trim().min(1),
  planType: z.string().trim().min(1),
  priceId: z.string().trim().min(1),
});

export const stripeChangeSubscriptionBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  targetPlanType: z.string().trim().min(1),
  targetPriceId: z.string().trim().min(1),
});

export const stripeCancelSubscriptionBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
});

export const stripeSubscriptionStatusQuerySchema = z.object({
  restaurantId: z.string().trim().min(1),
});
