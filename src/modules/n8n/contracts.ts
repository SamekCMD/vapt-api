export type N8nAuthStrategy = "app" | "admin" | "none";
export type N8nMethod = "GET" | "POST";

export const n8nContracts = {
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
} as const;

export type N8nOperation = keyof typeof n8nContracts;
