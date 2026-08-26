export type N8nAuthStrategy = "app" | "webhookSetup" | "admin" | "none";
export type N8nMethod = "GET" | "POST";

export const n8nContracts = {
  "asaas.webhookForward": {
    method: "POST",
    path: "/asaas/webhook",
    auth: "none",
  },
  "stripe.subscriptionCreate": {
    method: "POST",
    path: "/stripe/subscription/create",
    auth: "app",
  },
  "stripe.subscriptionChange": {
    method: "POST",
    path: "/stripe/subscription/change",
    auth: "app",
  },
  "stripe.subscriptionCancel": {
    method: "POST",
    path: "/stripe/subscription/cancel",
    auth: "app",
  },
  "stripe.subscriptionStatus": {
    method: "GET",
    path: "/stripe/subscription/status",
    auth: "app",
  },
  "stripe.health": {
    method: "GET",
    path: "/stripe/health",
    auth: "admin",
  },
  "stripe.webhookForward": {
    method: "POST",
    path: "/stripe/webhook",
    auth: "none",
  },
  "ingest.pushSubscription": {
    method: "POST",
    path: "/ingest/push-subscription",
    auth: "app",
  },
  "ingest.orderFeedback": {
    method: "POST",
    path: "/ingest/order-feedback",
    auth: "app",
  },
} as const;

export type N8nOperation = keyof typeof n8nContracts;
