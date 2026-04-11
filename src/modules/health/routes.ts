import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimitGroup: "health" } }, async () => {
    return { status: "ok" };
  });

  app.get("/health/ready", { config: { rateLimitGroup: "health" } }, async () => {
    return { status: "ready" };
  });
}
