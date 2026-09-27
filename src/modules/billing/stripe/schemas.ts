import { z } from "zod";

export const stripePlanTypeSchema = z.enum(["starter", "pro", "business"]);
export type StripePlanType = z.infer<typeof stripePlanTypeSchema>;

export const stripeCheckoutBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  planType: stripePlanTypeSchema,
}).strict();

export const stripeChangeSubscriptionBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  targetPlanType: stripePlanTypeSchema,
}).strict();

export const stripeCancelSubscriptionBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
}).strict();

export const stripePortalBodySchema = stripeCancelSubscriptionBodySchema;

export const stripeSubscriptionStatusQuerySchema = z.object({
  restaurantId: z.string().trim().min(1),
}).strict();
