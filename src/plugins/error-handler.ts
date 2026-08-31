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
    request.log.error(
      {
        err: error,
        diagnostics: error instanceof AppError ? error.diagnostics : undefined,
      },
      "request failed",
    );

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message:
            error.code === "internal_error"
              ? "Internal server error"
              : error.code === "unauthorized"
                ? "Unauthorized"
                : error.code === "forbidden"
                  ? "Forbidden"
                  : error.code === "invalid_request"
                    ? "Invalid request"
                    : error.code === "rate_limit_exceeded"
                      ? "Too many requests"
                  : error.message,
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
