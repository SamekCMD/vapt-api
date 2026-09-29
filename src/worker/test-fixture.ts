import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";

type FixtureBindings = WorkerBindings & { TEST_GREETING: string };

const app = createWorkerApp();
app.get("/_test/echo/:value", (context) => context.json({
  value: context.req.param("value"),
  query: context.req.query("q"),
  greeting: (context.env as FixtureBindings).TEST_GREETING,
}));

export default { fetch: app.fetch };
