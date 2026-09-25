import { fromNodeHeaders } from "better-auth/node";

import type { AuthContext } from "../../plugins/auth.js";
import type { AuthRuntime } from "./runtime.js";

export type SessionResolver = (
  headers: NodeJS.Dict<string | string[]>,
) => Promise<AuthContext | null>;

export function createSessionResolver(runtime: AuthRuntime): SessionResolver {
  return async (headers) => {
    const session = await runtime.getSession(fromNodeHeaders(headers));

    if (!session) {
      return null;
    }

    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      role: "authenticated",
    };
  };
}
