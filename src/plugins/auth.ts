import type { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../lib/errors.js";
import type { SessionResolver } from "../modules/auth/session-resolver.js";
import type { TenantActor } from "../modules/tenancy/contracts.js";
import { tenantActorSchema } from "../modules/tenancy/contracts.js";

export type AuthContext = {
  userId: string;
  email: string | null;
  role: "authenticated";
  sessionId?: string;
  sessionExpiresAt?: number;
};

export function actorFromAuth(auth: AuthContext): TenantActor {
  const parsed = tenantActorSchema.safeParse({ userId:auth.userId, sessionId:auth.sessionId, sessionExpiresAt:auth.sessionExpiresAt });
  if (auth.role !== 'authenticated' || !parsed.success || parsed.data.sessionExpiresAt <= Date.now()) {
    throw new AppError(401, 'unauthorized', 'Unauthorized');
  }
  return parsed.data;
}

// Public DTO is intentionally not the internal AuthContext.
export function authIdentityDto(auth: AuthContext) {
  return { userId:auth.userId, email:auth.email, role:auth.role };
}

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
