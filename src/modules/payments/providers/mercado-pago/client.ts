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

function mapTokenResponse(value: RawTokenResponse): MercadoPagoTokenResponse {
  if (
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    typeof value.token_type !== "string" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    typeof value.scope !== "string" ||
    (typeof value.user_id !== "string" && typeof value.user_id !== "number") ||
    typeof value.live_mode !== "boolean"
  ) {
    throw new AppError(
      502,
      "mercado_pago_oauth_failed",
      "Mercado Pago returned an invalid OAuth response",
    );
  }

  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    tokenType: value.token_type,
    expiresIn: value.expires_in,
    scope: value.scope,
    userId: String(value.user_id),
    liveMode: value.live_mode,
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
        headers: { "content-type": "application/json" },
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
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago OAuth request failed",
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
