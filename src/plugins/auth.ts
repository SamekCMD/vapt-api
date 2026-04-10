import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import { verifySupabaseToken } from "../lib/jwt.js";

export type AuthContext = {
  userId: string;
  email: string | null;
  role: string;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function registerAuthDecorator(app: { decorateRequest: (name: string, value: unknown) => void }) {
  app.decorateRequest("auth", null);
}

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  config: AppConfig,
) {
  const authorization = request.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  const payload = verifySupabaseToken(token, config.supabase.jwtSecret);

  request.auth = {
    userId: payload.sub,
    email: payload.email ?? null,
    role: payload.role ?? "authenticated",
  };
}
