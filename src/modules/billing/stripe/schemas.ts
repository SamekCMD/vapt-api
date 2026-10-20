import { z } from "zod";

export const stripePlanTypeSchema = z.enum(["starter", "pro", "business"]);
export type StripePlanType = z.infer<typeof stripePlanTypeSchema>;


const selector={organizationId:z.string().uuid().transform(value=>value.toLowerCase()).optional(),
  restaurantId:z.string().uuid().transform(value=>value.toLowerCase()).optional()};
const selected=(value:{organizationId?:string;restaurantId?:string})=>Boolean(value.organizationId||value.restaurantId);
export const stripeCheckoutBodySchema=z.object({...selector,planType:stripePlanTypeSchema}).strict().refine(selected);
export const stripePortalBodySchema=z.object(selector).strict().refine(selected);
export const stripeSubscriptionStatusQuerySchema=z.object(selector).strict().refine(selected);
