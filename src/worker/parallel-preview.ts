import type { ExecutionContext } from "hono";

import apiWorker from "./index.js";
import type { WorkerBindings } from "./environment.js";

type ParallelPreviewBindings = WorkerBindings & { PARALLEL_PREVIEW_TOKEN?: string };

function failure(status: 401 | 503): Response {
  return Response.json({
    error: status === 401
      ? { code: "unauthorized", message: "Unauthorized" }
      : { code: "service_unavailable", message: "Service unavailable" },
  }, { status, headers: { "cache-control": "no-store" } });
}

async function validBearer(expected: string, header: string | null): Promise<boolean> {
  if (!header || header.length > 263) return false;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) return false;

  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
  ]);
  const left = new Uint8Array(expectedDigest);
  const right = new Uint8Array(suppliedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function handleParallelPreview(
  request: Request,
  env: ParallelPreviewBindings,
  context: ExecutionContext,
  delegate: typeof apiWorker.fetch = apiWorker.fetch,
): Promise<Response> {
  if (env.ENVIRONMENT !== "preview" || !env.PARALLEL_PREVIEW_TOKEN ||
    env.PARALLEL_PREVIEW_TOKEN.length < 32 || env.PARALLEL_PREVIEW_TOKEN.length > 256) {
    return failure(503);
  }
  if (!await validBearer(env.PARALLEL_PREVIEW_TOKEN, request.headers.get("authorization"))) {
    return failure(401);
  }

  try {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    return await delegate(new Request(request, { headers }), env, context);
  } catch {
    return failure(503);
  }
}

export default {
  fetch(request: Request, env: ParallelPreviewBindings, context: ExecutionContext): Promise<Response> {
    return handleParallelPreview(request, env, context);
  },
};
