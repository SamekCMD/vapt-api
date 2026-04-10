import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const fastifyRawBody = require("fastify-raw-body") as Parameters<FastifyInstance["register"]>[0];

export async function registerRawBody(app: FastifyInstance) {
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
}
