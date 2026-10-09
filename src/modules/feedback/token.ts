import { AppError } from "../../lib/errors.js";

export function requireOrderToken(headers: Record<string, unknown>): string {
  const token = headers["x-vapt-order-token"];
  if (typeof token !== "string" || token.trim().length < 32 || token.length > 256) {
    throw new AppError(401, "invalid_order_token", "Invalid order token");
  }
  return token.trim();
}
