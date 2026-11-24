import type { ExecutionContext } from "hono";

import { createWorkerApp } from "./app.js";
import { configFromWorkerBindings, type WorkerBindings } from "./environment.js";
import { createWorkerServices } from "./services.js";
import { runScheduledReconciliation } from "./scheduled.js";
import { createApiDiagnostics } from "./diagnostics.js";

const app = createWorkerApp(createWorkerServices);

export default {
  fetch(request: Request, env: WorkerBindings, context: ExecutionContext): Promise<Response> | Response {
    const emit = createApiDiagnostics(env.ENVIRONMENT === "production" ? env.DIAGNOSTICS : undefined);
    try {
      configFromWorkerBindings(env);
    } catch {
      emit("config_invalid");
      return Response.json({
        error: { code: "service_unavailable", message: "Service unavailable" },
      }, { status: 503 });
    }
    return (async () => {
      try {
        const response = await app.fetch(request, env, context);
        if (response.status >= 500) emit("http_5xx");
        return response;
      } catch (error) {
        emit("fetch_failed");
        throw error;
      }
    })();
  },
  async scheduled(_event: unknown, env: WorkerBindings, context: ExecutionContext): Promise<void> {
    const emit = createApiDiagnostics(env.ENVIRONMENT === "production" ? env.DIAGNOSTICS : undefined);
    try {
      configFromWorkerBindings(env);
      const services = await createWorkerServices(env, context);
      await runScheduledReconciliation(services);
    } catch (error) {
      emit("scheduled_failed");
      throw error;
    }
  },
};
