import { z } from "zod";

const priceSchema = z.string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) >= 0);

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable();
const nullableText = (max: number) => z.string().trim().max(max).nullable();

const variationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
  required: z.boolean(),
}).strict();

const menuItemFields = {
  name: z.string().trim().min(2).max(80),
  price: priceSchema,
  description: nullableText(1000),
  category: z.string().trim().min(1).max(80),
  available: z.boolean(),
  imageUrl: z.string().url().max(2048).nullable(),
  availableFrom: timeSchema,
  availableUntil: timeSchema,
  badge: z.enum(["destaque", "promocao", "novo"]).nullable(),
  isChefSuggestion: z.boolean(),
  prepTimeMinutes: z.number().int().min(0).max(1440).nullable(),
  variations: z.array(variationSchema).max(20),
};

export const createMenuItemBodySchema = z.object(menuItemFields).strict();

export const updateMenuItemBodySchema = z.object({
  name: menuItemFields.name.optional(),
  price: menuItemFields.price.optional(),
  description: menuItemFields.description.optional(),
  category: menuItemFields.category.optional(),
  available: menuItemFields.available.optional(),
  imageUrl: menuItemFields.imageUrl.optional(),
  availableFrom: menuItemFields.availableFrom.optional(),
  availableUntil: menuItemFields.availableUntil.optional(),
  badge: menuItemFields.badge.optional(),
  isChefSuggestion: menuItemFields.isChefSuggestion.optional(),
  prepTimeMinutes: menuItemFields.prepTimeMinutes.optional(),
  variations: menuItemFields.variations.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0);

export const menuItemParamsSchema = z.object({
  itemId: z.string().uuid(),
}).strict();

export type MenuVariationInput = z.infer<typeof variationSchema>;
export type CreateMenuItemBody = z.infer<typeof createMenuItemBodySchema>;
export type UpdateMenuItemBody = z.infer<typeof updateMenuItemBodySchema>;
