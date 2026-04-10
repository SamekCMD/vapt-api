import Fastify from "fastify";

export function buildApp() {
  const app = Fastify();

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/health/ready", async () => {
    return { status: "ready" };
  });

  return app;
}
