import { z } from "zod";

const slugSchema = z.string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const nullableText = (max: number) => z.string().trim().max(max).nullable();

export const onboardingBodySchema = z.object({
  restaurantName: z.string().trim().min(2).max(80),
  slug: slugSchema,
  dishName: z.string().trim().min(2).max(80),
  dishPrice: z.string()
    .trim()
    .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
    .refine((value) => Number(value) >= 0),
}).strict();

export const updateOwnedRestaurantBodySchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  slug: slugSchema.optional(),
  cnpj: nullableText(32).optional(),
  whatsapp: nullableText(32).optional(),
  address: nullableText(240).optional(),
  phone: nullableText(32).optional(),
  hours: nullableText(240).optional(),
  description: nullableText(1000).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontFamily: z.enum(["modern", "classic", "rounded"]).optional(),
  logoUrl: nullableText(2048).optional(),
  totalTables: z.number().int().min(1).max(1000).optional(),
  maxTables: z.number().int().min(1).max(1000).optional(),
  paymentMode: z.enum(["open_tab", "prepaid"]).optional(),
  maxPendingOrders: z.number().int().min(1).max(100).optional(),
  localEnabled: z.boolean().optional(),
  deliveryEnabled: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0);

export type OnboardingBody = z.infer<typeof onboardingBodySchema>;
export type UpdateOwnedRestaurantBody = z.infer<typeof updateOwnedRestaurantBodySchema>;
