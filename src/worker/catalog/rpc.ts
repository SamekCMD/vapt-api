import { AppError } from "../../lib/errors.js";

export type CatalogRpcReply<T> = { ok: true; value: T } | { ok: false; error: { status: number; code: string } };
const statuses = [400, 401, 403, 404, 409, 410, 413, 429, 503];
const unavailable = { status: 503, code: "catalog_operation_unavailable" };

export async function catalogRpcReply<T>(work: () => Promise<T>): Promise<CatalogRpcReply<T>> {
  try { return { ok: true, value: await work() }; }
  catch (error) {
    const safe = error instanceof AppError && statuses.includes(error.statusCode) && /^[a-z0-9_]{1,64}$/.test(error.code);
    return { ok: false, error: safe ? { status: error.statusCode, code: error.code } : unavailable };
  }
}

export function unwrapCatalogRpc<T>(reply: CatalogRpcReply<T>): T {
  if (reply && reply.ok === true) return reply.value;
  const error = reply && reply.ok === false && reply.error;
  if (!error || !statuses.includes(error.status) || typeof error.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(error.code)) {
    throw new AppError(unavailable.status, unavailable.code, "Catalog operation unavailable");
  }
  throw new AppError(error.status, error.code, "Catalog operation failed");
}
