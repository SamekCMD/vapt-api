import {z} from 'zod';
export const uuidSchema=z.string().uuid().transform(value=>value.toLowerCase());
export const bootstrapQuerySchema=z.object({restaurantId:uuidSchema.optional()}).strict();
export const selectionSchema=z.object({organizationId:uuidSchema,restaurantId:uuidSchema}).strict();
export const organizationParamsSchema=z.object({organizationId:uuidSchema}).strict();
