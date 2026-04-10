import { createHmac } from "node:crypto";

import { AppError } from "./errors.js";

type JwtPayload = {
  sub: string;
  email?: string;
  role?: string;
  exp?: number;
};

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function verifySupabaseToken(token: string, jwtSecret: string): JwtPayload {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const payloadToVerify = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(payloadToVerify, jwtSecret);

  if (encodedSignature !== expectedSignature) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload)) as JwtPayload;

  if (!payload.sub) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  if (payload.exp && payload.exp * 1000 <= Date.now()) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  return payload;
}
