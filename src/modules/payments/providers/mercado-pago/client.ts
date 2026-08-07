import { AppError } from "../../../../lib/errors.js";

const TOKEN_ENDPOINT = "https://api.mercadopago.com/oauth/token";

export type MercadoPagoTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  userId: string;
  liveMode: boolean;
};

export type MercadoPagoOAuthClient = {
  exchangeAuthorizationCode: (input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    testToken: boolean;
  }) => Promise<MercadoPagoTokenResponse>;
  refreshAccessToken: (input: {
    refreshToken: string;
  }) => Promise<MercadoPagoTokenResponse>;
};

type FetchLike = typeof fetch;

type RawTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  user_id?: unknown;
  live_mode?: unknown;
};

type RawOAuthError = {
  error?: unknown;
};

async function readSafeProviderError(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as RawOAuthError;
    if (
      typeof payload.error === "string" &&
      /^[a-z0-9_]{1,64}$/i.test(payload.error)
    ) {
      return payload.error;
    }
  } catch {
    // Provider responses are untrusted; omit malformed details.
  }

  return null;
}

function mapTokenResponse(value: RawTokenResponse): MercadoPagoTokenResponse {
  const invalidFields: string[] = [];
  const accessToken = typeof value.access_token === "string" && value.access_token.length > 0
    ? value.access_token
    : null;
  const refreshToken = typeof value.refresh_token === "string" && value.refresh_token.length > 0
    ? value.refresh_token
    : null;
  const expiresIn = typeof value.expires_in === "number"
    ? value.expires_in
    : typeof value.expires_in === "string" && /^\d+$/.test(value.expires_in)
      ? Number(value.expires_in)
      : Number.NaN;
  const userId = typeof value.user_id === "string" || typeof value.user_id === "number"
    ? String(value.user_id)
    : null;

  if (!accessToken) invalidFields.push("access_token");
  if (!refreshToken) invalidFields.push("refresh_token");
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) invalidFields.push("expires_in");
  if (!userId) invalidFields.push("user_id");

  if (
    !accessToken ||
    !refreshToken ||
    !Number.isFinite(expiresIn) || expiresIn <= 0 ||
    !userId
  ) {
    throw new AppError(
      424,
      "mercado_pago_oauth_failed",
      `Mercado Pago returned invalid OAuth fields: ${invalidFields.join(", ")}`,
    );
  }

  const scope = typeof value.scope === "string"
    ? value.scope
    : Array.isArray(value.scope) && value.scope.every((entry) => typeof entry === "string")
      ? value.scope.join(" ")
      : "";
  const tokenType = typeof value.token_type === "string" && value.token_type.length > 0
    ? value.token_type
    : "bearer";
  const liveMode = typeof value.live_mode === "boolean"
    ? value.live_mode
    : !accessToken.startsWith("TEST-");

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresIn,
    scope,
    userId,
    liveMode,
  };
}

export function createMercadoPagoOAuthClient(input: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}): MercadoPagoOAuthClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  async function requestToken(body: Record<string, unknown>): Promise<MercadoPagoTokenResponse> {
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          ...body,
        }),
      });
    } catch {
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago OAuth request failed",
      );
    }

    if (!response.ok) {
      const providerError = await readSafeProviderError(response);
      throw new AppError(
        424,
        "mercado_pago_oauth_failed",
        providerError
          ? `Mercado Pago OAuth request failed (${providerError})`
          : "Mercado Pago OAuth request failed",
      );
    }

    let payload: RawTokenResponse;
    try {
      payload = await response.json() as RawTokenResponse;
    } catch {
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago returned an invalid OAuth response",
      );
    }

    return mapTokenResponse(payload);
  }

  return {
    exchangeAuthorizationCode(exchangeInput) {
      return requestToken({
        grant_type: "authorization_code",
        code: exchangeInput.code,
        redirect_uri: exchangeInput.redirectUri,
        code_verifier: exchangeInput.codeVerifier,
        test_token: exchangeInput.testToken,
      });
    },

    refreshAccessToken(refreshInput) {
      return requestToken({
        grant_type: "refresh_token",
        refresh_token: refreshInput.refreshToken,
      });
    },
  };
}
