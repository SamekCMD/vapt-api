import "fastify";

import type { PaymentModule } from "../modules/payments/service.js";

declare module "fastify" {
  interface FastifyInstance {
    payments: PaymentModule;
  }

  interface FastifyRequest {
    rawBody?: string;
  }

  interface FastifyContextConfig {
    rateLimitGroup?: "auth" | "billing" | "orders" | "webhooks" | "health";
  }
}

export {};
