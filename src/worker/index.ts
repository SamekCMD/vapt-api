import type { ExecutionContext } from "hono";

import { createWorkerApp } from "./app.js";
import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";
import { createWorkerServices } from "./services.js";
import { runScheduledReconciliation } from "./scheduled.js";

const app = createWorkerApp(createWorkerServices);

export default {
  fetch(request: Request, env: WorkerBindings, context: ExecutionContext): Promise<Response> | Response {
    try {
      configFromWorkerBindings(env);
    } catch {
      return Response.json({
        error: { code: "service_unavailable", message: "Service unavailable" },
      }, { status: 503 });
    }
    return app.fetch(request, env, context);
  },
  async scheduled(_event: unknown, env: WorkerBindings, context: ExecutionContext): Promise<void> {
    configFromWorkerBindings(env);
    const services = await createWorkerServices(env, context);
    await runScheduledReconciliation(services);
  },
};
