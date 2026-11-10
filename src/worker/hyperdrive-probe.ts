import type { Pool } from "pg";

import { createWorkerDatabase } from "./database.js";
import type { WorkerBindings } from "./environment.js";
import { runProbeOperation } from "./hyperdrive-probe-operations.js";

const operations = new Set([
  "identity", "query", "transaction", "auth/create", "auth/read", "auth/revoke", "reconcile",
]);

export type ProbeBindings = Pick<WorkerBindings, "ENVIRONMENT" | "HYPERDRIVE"> & {
  PROBE_TOKEN?: string;
};

export type ProbeDependencies = {
  createDatabase(env: ProbeBindings): Pool;
  runOperation(operation: string, database: Pool, env: ProbeBindings): Promise<Response>;
};

const defaultDependencies: ProbeDependencies = {
  createDatabase: (env) => createWorkerDatabase(env, { diagnostic: true }),
  runOperation: runProbeOperation,
};

function response(status: number): Response {
  return Response.json({ ok: false }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function sameToken(expected: string | undefined, supplied: string | null): Promise<boolean> {
  if (!expected || expected.length > 256 || !supplied?.startsWith("Bearer ") || supplied.length > 263) {
    return false;
  }
  const input = supplied.slice(7);
  const encoder = new TextEncoder();
  const [expectedHash, inputHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(input)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(inputHash);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

export async function handleHyperdriveProbe(
  request: Request,
  env: ProbeBindings,
  dependencies: Partial<ProbeDependencies> = {},
): Promise<Response> {
  if (env.ENVIRONMENT !== "preview") return response(503);
  if (!await sameToken(env.PROBE_TOKEN, request.headers.get("authorization"))) return response(401);
  if (request.method !== "POST") return response(405);

  const operation = new URL(request.url).pathname.slice(1);
  if (!operations.has(operation)) return response(404);

  try {
    const database = (dependencies.createDatabase ?? defaultDependencies.createDatabase)(env);
    const result = await (dependencies.runOperation ?? defaultDependencies.runOperation)(operation, database, env);
    result.headers.set("cache-control", "no-store");
    return result;
  } catch {
    return response(503);
  }
}

export default {
  fetch(request: Request, env: ProbeBindings) {
    return handleHyperdriveProbe(request, env);
  },
};
