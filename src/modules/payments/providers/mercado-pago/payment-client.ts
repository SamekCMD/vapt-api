import { AppError } from "../../../../lib/errors.js";

const PAYMENT_ENDPOINT = "https://api.mercadopago.com/v1/payments";
const PAYMENT_SEARCH_ENDPOINT = `${PAYMENT_ENDPOINT}/search`;

type FetchLike = typeof fetch;

type RawPaymentResponse = {
  id?: unknown;
  status?: unknown;
  status_detail?: unknown;
  transaction_amount?: unknown;
  currency_id?: unknown;
  external_reference?: unknown;
  collector_id?: unknown;
  date_last_updated?: unknown;
  payment_method_id?: unknown;
};

type RawPaymentSearchResponse = {
  results?: unknown;
};

export type MercadoPagoPaymentResult = {
  id: string;
  status: string;
  statusDetail: string;
  transactionAmount: string;
  currency: string;
  externalReference: string | null;
  collectorId: string;
  dateLastUpdated: string | null;
  paymentMethodId: string | null;
};

export type MercadoPagoPaymentClient = {
  getPayment(input: {
    accessToken: string;
    paymentId: string;
  }): Promise<MercadoPagoPaymentResult>;
  searchPayments(input: {
    accessToken: string;
    externalReference: string;
  }): Promise<MercadoPagoPaymentResult[]>;
};

function requiredString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function mapPaymentResponse(value: RawPaymentResponse): MercadoPagoPaymentResult {
  const id = requiredString(value.id);
  const status = requiredString(value.status);
  const amount = typeof value.transaction_amount === "number"
    ? value.transaction_amount
    : typeof value.transaction_amount === "string"
      ? Number(value.transaction_amount)
      : Number.NaN;
  const currency = requiredString(value.currency_id);
  const collectorId = requiredString(value.collector_id);
  if (!id || !status || !Number.isFinite(amount) || amount < 0 || !currency || !collectorId) {
    throw new AppError(
      502,
      "mercado_pago_payment_failed",
      "Mercado Pago returned an invalid payment response",
    );
  }

  return {
    id,
    status,
    statusDetail: requiredString(value.status_detail) ?? status,
    transactionAmount: amount.toFixed(2),
    currency,
    externalReference: requiredString(value.external_reference),
    collectorId,
    dateLastUpdated: requiredString(value.date_last_updated),
    paymentMethodId: requiredString(value.payment_method_id),
  };
}

export function createMercadoPagoPaymentClient(input: {
  fetchImpl?: FetchLike;
} = {}): MercadoPagoPaymentClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async getPayment(payment) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${PAYMENT_ENDPOINT}/${encodeURIComponent(payment.paymentId)}`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${payment.accessToken}`,
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        throw new AppError(
          502,
          "mercado_pago_payment_failed",
          "Mercado Pago payment request failed",
        );
      }

      if (!response.ok) {
        throw new AppError(
          424,
          "mercado_pago_payment_failed",
          "Mercado Pago payment request failed",
        );
      }

      try {
        return mapPaymentResponse(await response.json() as RawPaymentResponse);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          502,
          "mercado_pago_payment_failed",
          "Mercado Pago returned an invalid payment response",
        );
      }
    },
    async searchPayments(search) {
      const url = new URL(PAYMENT_SEARCH_ENDPOINT);
      url.searchParams.set("external_reference", search.externalReference);
      url.searchParams.set("sort", "date_created");
      url.searchParams.set("criteria", "desc");

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${search.accessToken}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError(
          502,
          "mercado_pago_payment_failed",
          "Mercado Pago payment search failed",
        );
      }

      if (!response.ok) {
        throw new AppError(
          424,
          "mercado_pago_payment_failed",
          "Mercado Pago payment search failed",
        );
      }

      try {
        const body = await response.json() as RawPaymentSearchResponse;
        if (!Array.isArray(body.results)) {
          throw new AppError(
            502,
            "mercado_pago_payment_failed",
            "Mercado Pago returned an invalid payment search response",
          );
        }
        return body.results.map((payment) => mapPaymentResponse(payment as RawPaymentResponse));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          502,
          "mercado_pago_payment_failed",
          "Mercado Pago returned an invalid payment search response",
        );
      }
    },
  };
}
