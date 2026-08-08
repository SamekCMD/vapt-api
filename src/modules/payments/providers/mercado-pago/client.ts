import { AppError } from "../../../../lib/errors.js";
import type { PaymentEnvironment } from "../../types.js";

const TOKEN_ENDPOINT = "https://api.mercadopago.com/oauth/token";
const PREFERENCE_ENDPOINT = "https://api.mercadopago.com/checkout/preferences";
const SANDBOX_MARKETPLACE_FEE = 0.01;

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
export type MercadoPagoPreferenceInput = {
  accessToken: string;
  environment: PaymentEnvironment;
  transactionId: string;
  restaurantId: string;
  orderId: string;
  amount: { amount: string; currency: string };
  description: string;
  returnUrls: { success: URL; pending: URL; failure: URL };
  notificationUrl: URL;
};

export type MercadoPagoPreferenceResult = {
  preferenceId: string;
  checkoutUrl: URL;
  diagnostics: MercadoPagoCheckoutDiagnostics;
};

export type MercadoPagoCheckoutDiagnostics = {
  collectorId: string | null;
  clientId: string | null;
  marketplace: string | null;
  siteId: string | null;
  operationType: string | null;
  checkoutHost: string;
  sandboxCheckoutHost: string | null;
};

export type MercadoPagoPersistedPreferenceDiagnostics = {
  preferenceId: string;
  collectorId: string | null;
  clientId: string | null;
  marketplace: string | null;
  marketplaceFee: string | null;
  siteId: string | null;
  operationType: string | null;
  externalReference: string | null;
  binaryMode: boolean | null;
  expires: boolean | null;
  preferenceExpired: boolean | null;
  purpose: string | null;
  processingModes: string[];
  itemCount: number;
  amount: string | null;
  currency: string | null;
  backUrlHosts: string[];
  notificationHost: string | null;
  checkoutHost: string | null;
  sandboxCheckoutHost: string | null;
};

export type MercadoPagoCheckoutClient = {
  createPreference(
    input: MercadoPagoPreferenceInput,
  ): Promise<MercadoPagoPreferenceResult>;
  getPreference(input: {
    accessToken: string;
    preferenceId: string;
  }): Promise<MercadoPagoPersistedPreferenceDiagnostics>;
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

type RawApplicationTokenResponse = {
  access_token?: unknown;
};

type RawOAuthError = {
  error?: unknown;
};

type RawPreferenceResponse = {
  id?: unknown;
  collector_id?: unknown;
  client_id?: unknown;
  marketplace?: unknown;
  site_id?: unknown;
  operation_type?: unknown;
  marketplace_fee?: unknown;
  external_reference?: unknown;
  binary_mode?: unknown;
  expires?: unknown;
  preference_expired?: unknown;
  purpose?: unknown;
  processing_modes?: unknown;
  items?: unknown;
  back_urls?: unknown;
  notification_url?: unknown;
  init_point?: unknown;
  sandbox_init_point?: unknown;
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

export function createMercadoPagoApplicationAccessTokenResolver(input: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}): () => Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;

  return async () => {
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
          grant_type: "client_credentials",
        }),
      });
    } catch {
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago application token request failed",
      );
    }

    if (!response.ok) {
      const providerError = await readSafeProviderError(response);
      const detail = providerError
        ? `status ${response.status}: ${providerError}`
        : `status ${response.status}`;
      throw new AppError(
        424,
        "mercado_pago_oauth_failed",
        `Mercado Pago application token request failed (${detail})`,
      );
    }

    let payload: RawApplicationTokenResponse;
    try {
      payload = await response.json() as RawApplicationTokenResponse;
    } catch {
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago returned an invalid application token response",
      );
    }

    if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      throw new AppError(
        502,
        "mercado_pago_oauth_failed",
        "Mercado Pago returned an invalid application token response",
      );
    }

    return payload.access_token;
  };
}

function isMercadoPagoCheckoutUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  return url.hostname === "mercadopago.com" ||
    url.hostname.endsWith(".mercadopago.com") ||
    url.hostname === "mercadopago.com.br" ||
    url.hostname.endsWith(".mercadopago.com.br");
}

function optionalProviderIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function optionalCheckoutHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return isMercadoPagoCheckoutUrl(url) ? url.hostname : null;
  } catch {
    return null;
  }
}

function optionalUrlHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : null;
  } catch {
    return null;
  }
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalMoney(value: unknown): string | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
}

function mapPersistedPreference(value: RawPreferenceResponse): MercadoPagoPersistedPreferenceDiagnostics {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid preference response");
  }

  const items = Array.isArray(value.items) ? value.items : [];
  let amount = 0;
  let amountValid = items.length > 0;
  let currency: string | null = null;
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") {
      amountValid = false;
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unit_price);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
      amountValid = false;
    } else {
      amount += quantity * unitPrice;
    }
    if (currency === null && typeof item.currency_id === "string") currency = item.currency_id;
  }

  const backUrls = value.back_urls && typeof value.back_urls === "object"
    ? Object.values(value.back_urls as Record<string, unknown>)
    : [];
  const backUrlHosts = [...new Set(backUrls.map(optionalUrlHost).filter((host): host is string => host !== null))];

  return {
    preferenceId: value.id,
    collectorId: optionalProviderIdentifier(value.collector_id),
    clientId: optionalProviderIdentifier(value.client_id),
    marketplace: optionalProviderIdentifier(value.marketplace),
    marketplaceFee: optionalMoney(value.marketplace_fee),
    siteId: optionalProviderIdentifier(value.site_id),
    operationType: optionalProviderIdentifier(value.operation_type),
    externalReference: optionalProviderIdentifier(value.external_reference),
    binaryMode: optionalBoolean(value.binary_mode),
    expires: optionalBoolean(value.expires),
    preferenceExpired: optionalBoolean(value.preference_expired),
    purpose: optionalProviderIdentifier(value.purpose),
    processingModes: Array.isArray(value.processing_modes)
      ? value.processing_modes.filter((mode): mode is string => typeof mode === "string")
      : [],
    itemCount: items.length,
    amount: amountValid ? amount.toFixed(2) : null,
    currency,
    backUrlHosts,
    notificationHost: optionalUrlHost(value.notification_url),
    checkoutHost: optionalCheckoutHost(value.init_point),
    sandboxCheckoutHost: optionalCheckoutHost(value.sandbox_init_point),
  };
}

function mapPreferenceResponse(value: RawPreferenceResponse): MercadoPagoPreferenceResult {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid checkout response");
  }

  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(typeof value.init_point === "string" ? value.init_point : "");
  } catch {
    throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid checkout response");
  }
  if (!isMercadoPagoCheckoutUrl(checkoutUrl)) {
    throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid checkout response");
  }

  return {
    preferenceId: value.id,
    checkoutUrl,
    diagnostics: {
      collectorId: optionalProviderIdentifier(value.collector_id),
      clientId: optionalProviderIdentifier(value.client_id),
      marketplace: optionalProviderIdentifier(value.marketplace),
      siteId: optionalProviderIdentifier(value.site_id),
      operationType: optionalProviderIdentifier(value.operation_type),
      checkoutHost: checkoutUrl.hostname,
      sandboxCheckoutHost: optionalCheckoutHost(value.sandbox_init_point),
    },
  };
}

export function createMercadoPagoCheckoutClient(input: {
  fetchImpl?: FetchLike;
} = {}): MercadoPagoCheckoutClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async createPreference(preference) {
      const amount = Number(preference.amount.amount);
      if (!Number.isFinite(amount) || amount <= 0 || preference.amount.currency !== "BRL") {
        throw new AppError(409, "order_not_payable", "Order does not have a payable total");
      }

      let response: Response;
      try {
        response = await fetchImpl(PREFERENCE_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${preference.accessToken}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            items: [{
              id: preference.orderId,
              title: preference.description,
              quantity: 1,
              currency_id: preference.amount.currency,
              unit_price: amount,
            }],
            external_reference: preference.transactionId,
            metadata: {
              transaction_id: preference.transactionId,
              restaurant_id: preference.restaurantId,
              order_id: preference.orderId,
            },
            back_urls: {
              success: preference.returnUrls.success.toString(),
              pending: preference.returnUrls.pending.toString(),
              failure: preference.returnUrls.failure.toString(),
            },
            auto_return: "approved",
            notification_url: preference.notificationUrl.toString(),
            marketplace_fee: preference.environment === "sandbox"
              ? SANDBOX_MARKETPLACE_FEE
              : 0,
          }),
        });
      } catch {
        throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago checkout request failed");
      }

      if (!response.ok) {
        throw new AppError(424, "mercado_pago_checkout_failed", "Mercado Pago checkout request failed");
      }

      try {
        return mapPreferenceResponse(await response.json() as RawPreferenceResponse);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid checkout response");
      }
    },

    async getPreference(preference) {
      let response: Response;
      try {
        response = await fetchImpl(`${PREFERENCE_ENDPOINT}/${encodeURIComponent(preference.preferenceId)}`, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${preference.accessToken}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago preference request failed");
      }

      if (!response.ok) {
        const providerError = await readSafeProviderError(response);
        const detail = providerError
          ? `status ${response.status}: ${providerError}`
          : `status ${response.status}`;
        throw new AppError(
          424,
          "mercado_pago_checkout_failed",
          `Mercado Pago preference request failed (${detail})`,
        );
      }

      try {
        return mapPersistedPreference(await response.json() as RawPreferenceResponse);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(502, "mercado_pago_checkout_failed", "Mercado Pago returned an invalid preference response");
      }
    },
  };
}
