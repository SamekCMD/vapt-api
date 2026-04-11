import { z } from "zod";

export const asaasSetupBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  asaasApiKey: z.string().trim().min(1),
  asaasEnvironment: z.enum(["production", "sandbox"]),
  asaasBillingDocument: z.string().trim().min(1),
});

export const asaasSetupStatusQuerySchema = z.object({
  restaurantId: z.string().trim().min(1),
});

export const asaasPixBodySchema = z.object({
  restaurantId: z.string().trim().min(1),
  orderId: z.string().trim().min(1),
  totalPrice: z.number().finite(),
});
