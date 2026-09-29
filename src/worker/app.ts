import { Hono } from "hono";

import type { WorkerBindings } from "./environment.js";

export type WorkerHonoEnv = { Bindings: WorkerBindings };

export function createWorkerApp(): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>();
  app.get("/health", (context) => context.json({ status: "ok" }));
  return app;
}
