import type { ExecutionContext } from "hono";

import { createWorkerApp } from "./app.js";
import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";

const app = createWorkerApp();

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
};
