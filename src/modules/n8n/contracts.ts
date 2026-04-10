export type N8nAuthStrategy = "app" | "webhookSetup" | "admin";
export type N8nMethod = "GET" | "POST";

export const n8nContracts = {
  "asaas.setup": {
    method: "POST",
    path: "/asaas/setup",
    auth: "webhookSetup",
  },
  "asaas.setupStatus": {
    method: "GET",
    path: "/asaas/setup/status",
    auth: "admin",
  },
  "asaas.setupRefresh": {
    method: "POST",
    path: "/asaas/setup/refresh",
    auth: "admin",
  },
  "asaas.pixCreate": {
    method: "POST",
    path: "/asaas/pix/create",
    auth: "app",
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
