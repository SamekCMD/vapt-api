import { z } from "zod";

export const stripeWebhookHeadersSchema = z.object({
  "stripe-signature": z.string().trim().min(1),
  "content-type": z.string().trim().optional(),
});
