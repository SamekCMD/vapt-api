import type { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../lib/errors.js";
import type { SessionResolver } from "../modules/auth/session-resolver.js";

export type AuthContext = {
  userId: string;
  email: string | null;
  role: "authenticated";
};

declare module "fastify" {
  interface FastifyInstance {
    authSessionResolver: SessionResolver;
  }

  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function registerAuthDecorator(
  app: {
    decorate: (name: string, value: unknown) => void;
    decorateRequest: (name: string, value: unknown) => void;
  },
  sessionResolver: SessionResolver,
) {
  app.decorate("authSessionResolver", sessionResolver);
  app.decorateRequest("auth", null);
}

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  sessionResolver: SessionResolver,
) {
  const auth = await sessionResolver(request.headers);

  if (!auth) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  request.auth = auth;
}
