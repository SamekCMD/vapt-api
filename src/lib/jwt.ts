import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";

import { AppError } from "./errors.js";

const asymmetricAlgorithms = ["ES256", "RS256"] as const;

export type VerifiedSupabaseClaims = {
  sub: string;
  email?: string;
  role?: string;
  iss: string;
  aud: string | string[];
  exp: number;
};

export type SupabaseJwtVerifier = (
  token: string,
) => Promise<VerifiedSupabaseClaims>;

export type SupabaseJwtVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  legacyJwtSecret: string;
};

function unauthorized(): AppError {
  return new AppError(401, "unauthorized", "Unauthorized");
}

function authenticationUnavailable(): AppError {
  return new AppError(
    503,
    "authentication_unavailable",
    "Authentication service unavailable",
  );
}

function isRemoteJwksInfrastructureError(error: unknown): boolean {
  if (error instanceof AppError) {
    return false;
  }

  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    (error instanceof errors.JOSEError && error.constructor === errors.JOSEError) ||
    !(error instanceof errors.JOSEError)
  );
}

function toVerifiedClaims(payload: JWTPayload): VerifiedSupabaseClaims {
  if (
    typeof payload.sub !== "string" ||
    payload.sub.trim() === "" ||
    typeof payload.iss !== "string" ||
    (
      typeof payload.aud !== "string" &&
      (!Array.isArray(payload.aud) || !payload.aud.every((value) => typeof value === "string"))
    ) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    throw unauthorized();
  }

  return {
    sub: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.role === "string" ? { role: payload.role } : {}),
    iss: payload.iss,
    aud: payload.aud,
    exp: payload.exp,
  };
}

export function createSupabaseJwtVerifier(
  options: SupabaseJwtVerifierOptions,
): SupabaseJwtVerifier {
  const remoteJwks = createRemoteJWKSet(options.jwksUrl);
  const legacyKey = new TextEncoder().encode(options.legacyJwtSecret);

  return async (token) => {
    let usedRemoteJwks = false;

    try {
      const protectedHeader = decodeProtectedHeader(token);
      const verificationOptions = {
        issuer: options.issuer,
        audience: options.audience,
      };
      const usesLegacyKey = protectedHeader.alg === "HS256";
      usedRemoteJwks = !usesLegacyKey;

      const result = usesLegacyKey
        ? await jwtVerify(token, legacyKey, {
            ...verificationOptions,
            algorithms: ["HS256"],
          })
        : await jwtVerify(token, remoteJwks, {
            ...verificationOptions,
            algorithms: [...asymmetricAlgorithms],
          });

      return toVerifiedClaims(result.payload);
    } catch (error) {
      if (usedRemoteJwks && isRemoteJwksInfrastructureError(error)) {
        throw authenticationUnavailable();
      }

      throw unauthorized();
    }
  };
}
