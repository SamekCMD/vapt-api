import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthRuntime } from "./runtime.js";

type BetterAuthHandler = AuthRuntime["handler"];

function createRequestUrl(request: FastifyRequest, baseUrl: URL): URL {
  const inboundUrl = new URL(request.raw.url ?? "/api/auth", "http://fastify.local");
  return new URL(`${inboundUrl.pathname}${inboundUrl.search}`, baseUrl.origin);
}

function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Uint8Array.from(body).buffer;
  return JSON.stringify(body);
}

async function forwardResponse(response: Response, reply: FastifyReply) {
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      reply.header(name, value);
    }
  });

  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header("set-cookie", setCookies);
  }

  const body = Buffer.from(await response.arrayBuffer());
  return reply.status(response.status).send(body.length > 0 ? body : null);
}

export async function registerBetterAuthHandler(
  app: FastifyInstance,
  baseUrl: URL,
  handler: BetterAuthHandler,
) {
  const routeHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD"
      ? undefined
      : serializeBody(request.body);
    const headers = fromNodeHeaders(request.headers);
    headers.set("host", baseUrl.host);
    headers.delete("content-length");
    const authRequest = new Request(createRequestUrl(request, baseUrl), {
      method,
      headers,
      body,
    });
    const response = await handler(authRequest);
    return forwardResponse(response, reply);
  };

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimitGroup: "auth" },
    handler: routeHandler,
  });
}
