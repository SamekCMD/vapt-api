import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import {
  createSupabaseJwtVerifier,
  type SupabaseJwtVerifier,
} from "../lib/jwt.js";

export type AuthContext = {
  userId: string;
  email: string | null;
  role: string;
};

const verifiers = new WeakMap<AppConfig, SupabaseJwtVerifier>();

function getVerifier(config: AppConfig): SupabaseJwtVerifier {
  const existing = verifiers.get(config);
  if (existing) {
    return existing;
  }

  const issuer = new URL("/auth/v1", config.supabase.url).toString().replace(/\/$/, "");
  const verifier = createSupabaseJwtVerifier({
    issuer,
    audience: "authenticated",
    jwksUrl: new URL("/auth/v1/.well-known/jwks.json", config.supabase.url),
    legacyJwtSecret: config.supabase.jwtSecret,
  });
  verifiers.set(config, verifier);
  return verifier;
}

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

  const payload = await getVerifier(config)(token);

  request.auth = {
    userId: payload.sub,
    email: payload.email ?? null,
    role: payload.role ?? "authenticated",
  };
}
