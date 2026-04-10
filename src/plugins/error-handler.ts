import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/errors.js";

export function registerErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.code === "internal_error" ? "Internal server error" : error.message,
        },
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    });
  });
}
