import {z} from 'zod';
export const draftBasicsSchema=z.object({name:z.string().trim().min(2).max(80),
  slug:z.string().trim().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),whatsapp:z.string().trim().max(32).nullable().optional()}).strict();
export const draftPatchSchema=draftBasicsSchema.partial().extend({localEnabled:z.boolean().optional(),deliveryEnabled:z.boolean().optional(),
  totalTables:z.number().int().min(1).max(1000).optional(),onboardingStep:z.union([z.literal(0),z.literal(1),z.literal(2)]).optional()})
  .strict().refine(patch=>Object.keys(patch).length>0);
export const guideModuleSchema=z.enum(['cashier','menu','kitchen','settings','overview']);
