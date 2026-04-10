import type { AppConfig } from "../../lib/config.js";
import { n8nContracts, type N8nAuthStrategy, type N8nOperation } from "./contracts.js";
import { N8nClientError } from "./errors.js";

type N8nCallOptions = {
  body?: unknown;
};

type N8nCallResult<TData = unknown> = {
  status: number;
  data: TData;
  headers: Headers;
};

type FetchLike = typeof fetch;

function getAuthHeader(config: AppConfig, auth: N8nAuthStrategy): [string, string] {
  if (auth === "app") {
    return ["x-vapt-app-key", config.n8n.secrets.app];
  }

  if (auth === "webhookSetup") {
    return ["x-vapt-webhook-key", config.n8n.secrets.webhookSetup];
  }

  return ["x-vapt-admin-key", config.n8n.secrets.admin];
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      throw new N8nClientError(
        "invalid_upstream_response",
        "n8n returned invalid JSON",
        response.status,
      );
    }
  }

  return await response.text();
}

export function createN8nClient(config: AppConfig, fetchImpl: FetchLike = fetch) {
  return {
    async call<TData = unknown>(
      operation: N8nOperation,
      options: N8nCallOptions = {},
    ): Promise<N8nCallResult<TData>> {
      const contract = n8nContracts[operation];
      const [headerName, headerValue] = getAuthHeader(config, contract.auth);
      const url = new URL(contract.path, config.n8n.baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.n8n.timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: contract.method,
          headers: {
            [headerName]: headerValue,
            ...(contract.method === "POST" ? { "content-type": "application/json" } : {}),
          },
          body: contract.method === "POST" && options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
          signal: controller.signal,
        });

        const data = await parseResponseBody(response);

        if (!response.ok) {
          throw new N8nClientError(
            "upstream_error",
            "n8n returned a non-success response",
            response.status,
          );
        }

        return {
          status: response.status,
          data: data as TData,
          headers: response.headers,
        };
      } catch (error) {
        if (error instanceof N8nClientError) {
          throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
          throw new N8nClientError("upstream_timeout", "n8n request timed out");
        }

        throw new N8nClientError(
          "upstream_connection_failed",
          "n8n request failed before receiving a response",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
