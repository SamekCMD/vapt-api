import { z } from "zod";

const orderItemSchema = z.object({
  menuItemId: z.string().uuid(),
  variationId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().trim().max(500).optional(),
}).strict();

const deliverySchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(30),
  street: z.string().trim().min(2).max(180),
  number: z.string().trim().min(1).max(30),
  neighborhood: z.string().trim().min(2).max(120),
  paymentMode: z.enum(["online", "on_delivery"]),
}).strict();

export const createOrderBodySchema = z.object({
  restaurantSlug: z.string().trim().min(1).max(120),
  channel: z.enum(["local", "delivery"]),
  tableNumber: z.number().int().min(1).max(9999).optional(),
  items: z.array(orderItemSchema).min(1).max(50),
  delivery: deliverySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.channel === "delivery" && !value.delivery) {
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "Delivery address is required",
    });
  }
  if (value.channel === "local" && value.delivery) {
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "Delivery address is not accepted for local orders",
    });
  }
  if (value.channel === "local" && !value.tableNumber) {
    context.addIssue({
      code: "custom",
      path: ["tableNumber"],
      message: "Table number is required for local orders",
    });
  }

});

export const createOrderHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(8).max(128),
}).passthrough();

export const publicOrderParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const publicOrderHeadersSchema = z.object({
  "x-vapt-order-token": z.string().trim().min(32).max(256),
}).passthrough();

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;
