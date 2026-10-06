import type { RateLimitGroup } from "../plugins/rate-limit.js";

type RouteContract = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  group: RateLimitGroup | null;
  auth: boolean;
  condition?: "mercado-pago" | "mercado-pago-sandbox" | "r2";
};

export const ROUTE_CONTRACTS: readonly RouteContract[] = [
  { method: "GET", path: "/health", group: "health", auth: false },
  { method: "GET", path: "/health/ready", group: "health", auth: false },
  { method: "GET", path: "/api/auth/*", group: "auth", auth: false },
  { method: "POST", path: "/api/auth/*", group: "auth", auth: false },
  { method: "GET", path: "/auth/me", group: "auth", auth: true },
  { method: "GET", path: "/auth/restaurants/:restaurantId/access", group: "auth", auth: true },
  { method: "GET", path: "/public/restaurants/:slug/catalog", group: "public", auth: false },
  { method: "PUT", path: "/public/orders/:orderId/feedback", group: "orders", auth: false },
  { method: "POST", path: "/public/orders", group: "orders", auth: false },
  { method: "GET", path: "/public/orders/:orderId", group: "orders", auth: false },
  { method: "GET", path: "/restaurants/me/menu-items", group: "auth", auth: true },
  { method: "POST", path: "/restaurants/me/menu-items", group: "auth", auth: true },
  { method: "PATCH", path: "/restaurants/me/menu-items/:itemId", group: "auth", auth: true },
  { method: "DELETE", path: "/restaurants/me/menu-items/:itemId", group: "auth", auth: true },
  { method: "GET", path: "/restaurants/me/kitchen/orders", group: "auth", auth: true },
  { method: "PATCH", path: "/restaurants/me/kitchen/orders/:orderId/status", group: "auth", auth: true },
  { method: "POST", path: "/ingest/order-feedback", group: "billing", auth: false },
  { method: "POST", path: "/ingest/push-subscription", group: "billing", auth: true },
  { method: "GET", path: "/restaurants/me/overview", group: "auth", auth: true },
  { method: "POST", path: "/admin/payments/effects/reprocess", group: "billing", auth: false },
  { method: "POST", path: "/billing/stripe/checkout", group: "billing", auth: true },
  { method: "POST", path: "/billing/stripe/portal", group: "billing", auth: true },
  { method: "GET", path: "/billing/stripe/subscription", group: "billing", auth: true },
  { method: "POST", path: "/webhooks/stripe", group: "webhooks", auth: false },
  { method: "GET", path: "/payments/mercado-pago/return", group: null, auth: false, condition: "mercado-pago" },
  { method: "POST", path: "/orders/:orderId/payments/manual-confirmation", group: "billing", auth: true },
  { method: "POST", path: "/public/orders/:orderId/payments/checkout", group: "billing", auth: false, condition: "mercado-pago" },
  { method: "GET", path: "/public/orders/:orderId/payments/:transactionId/diagnostics", group: "billing", auth: false, condition: "mercado-pago-sandbox" },
  { method: "POST", path: "/onboarding", group: "auth", auth: true },
  { method: "GET", path: "/restaurants/me", group: "auth", auth: true },
  { method: "PATCH", path: "/restaurants/me", group: "auth", auth: true },
  { method: "GET", path: "/restaurants/me/table-sessions", group: "auth", auth: true },
  { method: "GET", path: "/restaurants/me/table-sessions/:sessionId", group: "auth", auth: true },
  { method: "POST", path: "/restaurants/me/table-sessions/:sessionId/close", group: "auth", auth: true },
  { method: "POST", path: "/restaurants/me/table-sessions/:sessionId/transfer", group: "auth", auth: true },
  { method: "POST", path: "/public/table-sessions/:sessionId/request-check", group: "orders", auth: false },
  { method: "POST", path: "/restaurants/:restaurantId/menu-items/:itemId/image/upload", group: "storage", auth: true, condition: "r2" },
  { method: "DELETE", path: "/restaurants/:restaurantId/menu-items/:itemId/image", group: "storage", auth: true, condition: "r2" },
  { method: "POST", path: "/restaurants/:restaurantId/payments/mercado-pago/connect", group: "billing", auth: true, condition: "mercado-pago" },
  { method: "GET", path: "/payments/mercado-pago/oauth/callback", group: "billing", auth: false, condition: "mercado-pago" },
  { method: "GET", path: "/restaurants/:restaurantId/payments/mercado-pago/status", group: "billing", auth: true, condition: "mercado-pago" },
  { method: "DELETE", path: "/restaurants/:restaurantId/payments/mercado-pago/connection", group: "billing", auth: true, condition: "mercado-pago" },
  { method: "POST", path: "/webhooks/payments/mercado-pago", group: "webhooks", auth: false, condition: "mercado-pago" },
  { method: "POST", path: "/payments/mercado-pago/webhook", group: "webhooks", auth: false, condition: "mercado-pago" },
];

// Cloudflare-only additions are intentionally absent from legacy Fastify.
export const WORKER_ONLY_ROUTE_CONTRACTS: readonly RouteContract[] = [
  { method: "POST", path: "/v1/realtime/tickets", group: "public", auth: false },
  { method: "GET", path: "/v1/realtime/restaurants/:restaurantId/socket", group: "public", auth: false },
];
