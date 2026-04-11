import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "../lib/errors.js";

export type RateLimitGroup = "auth" | "billing" | "webhooks" | "health";

type RateLimitPolicy = {
  maxRequests: number;
  windowMs: number;
};

type RateLimitOptions = {
  policies?: Partial<Record<RateLimitGroup, RateLimitPolicy>>;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const defaultPolicies: Record<RateLimitGroup, RateLimitPolicy> = {
  auth: {
    maxRequests: 20,
    windowMs: 60_000,
  },
  billing: {
    maxRequests: 60,
    windowMs: 60_000,
  },
  webhooks: {
    maxRequests: 300,
    windowMs: 60_000,
  },
  health: {
    maxRequests: Number.MAX_SAFE_INTEGER,
    windowMs: 60_000,
  },
};

function getClientKey(request: FastifyRequest): string {
  const forwardedFor = request.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim() !== "") {
    return forwardedFor.split(",")[0]!.trim();
  }

  return request.ip;
}

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions = {}) {
  const policies = {
    ...defaultPolicies,
    ...options.policies,
  };
  const buckets = new Map<string, Bucket>();

  app.addHook("onRequest", async (request, reply) => {
    const rateLimitGroup = request.routeOptions.config?.rateLimitGroup as RateLimitGroup | undefined;

    if (!rateLimitGroup) {
      return;
    }

    const policy = policies[rateLimitGroup];
    const key = `${rateLimitGroup}:${getClientKey(request)}`;
    const now = Date.now();
    const existingBucket = buckets.get(key);
    const bucket =
      existingBucket && existingBucket.resetAt > now
        ? existingBucket
        : {
            count: 0,
            resetAt: now + policy.windowMs,
          };

    bucket.count += 1;
    buckets.set(key, bucket);

    reply.header("x-ratelimit-limit", policy.maxRequests);
    reply.header("x-ratelimit-remaining", Math.max(policy.maxRequests - bucket.count, 0));
    reply.header("x-ratelimit-reset", Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > policy.maxRequests) {
      throw new AppError(429, "rate_limit_exceeded", "Too many requests");
    }
  });
}
