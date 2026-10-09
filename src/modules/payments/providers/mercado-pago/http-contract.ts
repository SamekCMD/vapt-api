import { z } from "zod";

import type { AppConfig } from "../../../../lib/config.js";
import { AppError } from "../../../../lib/errors.js";
import { isAllowedOrigin } from "../../../../lib/origins.js";

export const restaurantParamsSchema = z.object({ restaurantId: z.string().uuid() }).strict();
const environmentSchema = z.enum(["sandbox", "production"]);
export const connectBodySchema = z.object({
  environment: environmentSchema,
  returnOrigin: z.string().trim().min(1).max(255).optional(),
}).strict();
export const environmentQuerySchema = z.object({ environment: environmentSchema }).strict();
export const callbackQuerySchema = z.object({
  state: z.string().min(16).max(512),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().min(1).max(128).optional(),
  error_description: z.string().max(512).optional(),
}).strict().refine((value) => Boolean(value.code || value.error));

export function resolveReturnOrigin(value: string | undefined, config: AppConfig): string {
  const fallbackOrigin = config.frontendUrl.origin;
  if (!value) return fallbackOrigin;
  let origin: string;
  try {
    const parsed = new URL(value);
    origin = parsed.origin;
    if (value !== origin) throw new Error("origin_only");
  } catch {
    throw new AppError(400, "oauth_return_origin_invalid", "OAuth return origin is invalid");
  }
  if (origin !== fallbackOrigin && !isAllowedOrigin(origin, config.corsOrigins)) {
    throw new AppError(400, "oauth_return_origin_invalid", "OAuth return origin is not allowed");
  }
  return origin;
}

export function createMercadoPagoOAuthRedirect(config: AppConfig, status: string, returnOrigin?: string): URL {
  const redirect = new URL("/dashboard/settings", returnOrigin ?? config.frontendUrl);
  redirect.searchParams.set("payment_provider", "mercado_pago");
  redirect.searchParams.set("connection", status);
  return redirect;
}
