import { AppError } from "../../lib/errors.js";

export class N8nClientError extends AppError {
  constructor(
    code: "upstream_timeout" | "upstream_connection_failed" | "upstream_error" | "invalid_upstream_response",
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(502, code, message);
    this.name = "N8nClientError";
  }
}
