import { Pool } from "pg";

import { ConfigError } from "../lib/config.js";
import type { WorkerBindings } from "./environment.js";

export function createWorkerDatabase(env: Pick<WorkerBindings, "HYPERDRIVE">): Pool {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new ConfigError("Missing required Worker binding: HYPERDRIVE");
  }
  return new Pool({ connectionString, max: 1 });
}
