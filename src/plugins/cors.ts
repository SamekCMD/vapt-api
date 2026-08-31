import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";
import type { AppConfig } from "../lib/config.js";

const VERCEL_DOMAIN_SUFFIX = ".vercel.app";

function matchesConfiguredVercelPreview(origin: string, pattern: string): boolean {
  const wildcardIndex = pattern.indexOf("*");

  if (
    wildcardIndex === -1 ||
    pattern.indexOf("*", wildcardIndex + 1) !== -1 ||
    !pattern.startsWith("https://") ||
    !pattern.endsWith(VERCEL_DOMAIN_SUFFIX)
  ) {
    return false;
  }

  const hostnamePattern = pattern.slice("https://".length);

  if (hostnamePattern.includes("/")) {
    return false;
  }

  let requestedUrl: URL;

  try {
    requestedUrl = new URL(origin);
  } catch {
    return false;
  }

  if (
    requestedUrl.protocol !== "https:" ||
    requestedUrl.port !== "" ||
    requestedUrl.origin !== origin ||
    !requestedUrl.hostname.endsWith(VERCEL_DOMAIN_SUFFIX)
  ) {
    return false;
  }

  const [hostnamePrefix, hostnameSuffix] = hostnamePattern.split("*");
  const requestedHostname = requestedUrl.hostname;

  if (
    !requestedHostname.startsWith(hostnamePrefix) ||
    !requestedHostname.endsWith(hostnameSuffix)
  ) {
    return false;
  }

  const wildcardValue = requestedHostname.slice(
    hostnamePrefix.length,
    requestedHostname.length - hostnameSuffix.length,
  );

  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(wildcardValue);
}

export function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some(
    (allowedOrigin) =>
      allowedOrigin === origin || matchesConfiguredVercelPreview(origin, allowedOrigin),
  );
}

export async function registerCors(app: FastifyInstance, config: AppConfig) {
  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isAllowedOrigin(origin, config.corsOrigins)) {
        callback(null, true);
        return;
      }

      callback(new AppError(500, "internal_error", "Origin not allowed"), false);
    },
  });
}
