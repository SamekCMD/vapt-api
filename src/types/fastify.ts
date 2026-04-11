import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }

  interface FastifyContextConfig {
    rateLimitGroup?: "auth" | "billing" | "webhooks" | "health";
  }
}

export {};
