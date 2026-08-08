import { z } from "zod";

export const MANUAL_PAYMENT_METHODS = [
  "cash",
  "external_pix",
  "credit_card",
  "debit_card",
  "voucher",
  "other",
] as const;

export const manualPaymentBodySchema = z.object({
  paymentMethod: z.enum(MANUAL_PAYMENT_METHODS),
}).strict();

export const manualPaymentParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const manualPaymentHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(8).max(128),
}).passthrough();

export const hostedCheckoutBodySchema = z.object({}).strict();

export const hostedCheckoutParamsSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export const hostedCheckoutHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(8).max(128),
  "x-vapt-order-token": z.string().trim().min(32).max(256),
}).passthrough();

export const paymentDiagnosticsParamsSchema = z.object({
  orderId: z.string().uuid(),
  transactionId: z.string().uuid(),
}).strict();

export const paymentDiagnosticsHeadersSchema = z.object({
  "x-vapt-order-token": z.string().trim().min(32).max(256),
}).passthrough();
