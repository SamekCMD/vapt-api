import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import { isAllowedOrigin } from "../../lib/origins.js";

export const SAFE_MERCADO_PAGO_RETURN_PARAMS = [
  "payment_id", "status", "external_reference", "merchant_order_id", "preference_id",
] as const;

export function queryStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

export function resolveHostedCheckoutReturnOrigin(
  requestedOrigin: string | null | undefined,
  config: AppConfig,
): string {
  const fallbackOrigin = config.frontendUrl.origin;
  if (!requestedOrigin) return fallbackOrigin;
  try {
    const url = new URL(requestedOrigin);
    const isOriginOnly = url.origin === requestedOrigin && url.pathname === "/"
      && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    return isOriginOnly && isAllowedOrigin(url.origin, config.corsOrigins)
      ? url.origin : fallbackOrigin;
  } catch {
    return fallbackOrigin;
  }
}

export function createMercadoPagoReturnUrls(config: AppConfig, requestedOrigin?: string) {
  if (!config.apiPublicUrl) {
    throw new AppError(503, "mercado_pago_not_configured", "Mercado Pago return URL is not configured");
  }
  const returnOrigin = resolveHostedCheckoutReturnOrigin(requestedOrigin, config);
  const createUrl = (result: "success" | "pending" | "failure") => {
    const url = new URL("/payments/mercado-pago/return", config.apiPublicUrl);
    url.searchParams.set("result", result);
    url.searchParams.set("return_origin", returnOrigin);
    return url;
  };
  return { success: createUrl("success"), pending: createUrl("pending"), failure: createUrl("failure") };
}

export function createMercadoPagoBrowserReturnUrl(
  config: AppConfig,
  query: Record<string, unknown>,
  result: "success" | "pending" | "failure",
): URL {
  const returnOrigin = resolveHostedCheckoutReturnOrigin(queryStringValue(query.return_origin), config);
  const destination = new URL("/payment/return", returnOrigin);
  destination.searchParams.set("result", result);
  for (const parameter of SAFE_MERCADO_PAGO_RETURN_PARAMS) {
    const value = queryStringValue(query[parameter]);
    if (value !== null) destination.searchParams.set(parameter, value);
  }
  return destination;
}
