import { fromNodeHeaders } from "better-auth/node";

import type { AuthContext } from "../../plugins/auth.js";
import type { AuthRuntime } from "./runtime.js";

export type SessionResolver = (
  headers: NodeJS.Dict<string | string[]>,
) => Promise<AuthContext | null>;

export type FetchSessionResolver = (headers: Headers) => Promise<AuthContext | null>;

export function createSessionResolver(runtime: AuthRuntime): SessionResolver;
export function createSessionResolver(runtime: AuthRuntime, source: "fetch"): FetchSessionResolver;
export function createSessionResolver(runtime: AuthRuntime, source?: "fetch") {
  return async (headers: Headers | NodeJS.Dict<string | string[]>): Promise<AuthContext | null> => {
    const fetchHeaders = source === "fetch" ? headers as Headers
      : fromNodeHeaders(headers as NodeJS.Dict<string | string[]>);
    const session = await runtime.getSession(fetchHeaders);

    const expiresAt = session?.session.expiresAt;
    if (!session || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() || session.session.userId !== session.user.id) {
      return null;
    }

    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      role: "authenticated",
      sessionId: session.session.id,
      sessionExpiresAt: expiresAt.getTime(),
    };
  };
}
