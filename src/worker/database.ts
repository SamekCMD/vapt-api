import { Pool } from "pg";

import { ConfigError } from "../lib/config.js";
import type { WorkerBindings } from "./environment.js";

export function createWorkerDatabase(
  env: Pick<WorkerBindings, "HYPERDRIVE">,
  options: { diagnostic?: boolean } = {},
): Pool {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new ConfigError("Missing required Worker binding: HYPERDRIVE");
  }
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    // Hyperdrive does not forward these startup settings to Postgres. Effective
    // SQL deadlines come from the versioned API role defaults in DATABASE vapt.
    ...(options.diagnostic ? {
      statement_timeout: 8_000,
      query_timeout: 10_000,
      lock_timeout: 2_000,
    } : {}),
  });
}
