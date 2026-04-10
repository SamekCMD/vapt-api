import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../../lib/errors.js";

type StripeSignatureInput = {
  rawBody: string;
  signatureHeader: string | undefined;
  signingSecret: string;
  toleranceSeconds: number;
  now?: number;
};

type StripeEvent = {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
};

type AsaasPayload = Record<string, unknown>;

function parseJsonObject(rawBody: string, invalidMessage: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected object");
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(400, "invalid_request", invalidMessage);
  }
}

export function verifyStripeWebhookSignature(input: StripeSignatureInput): StripeEvent {
  if (!input.signatureHeader) {
    throw new AppError(401, "unauthorized", "Missing Stripe signature header");
  }

  const signatureParts: Record<string, string[]> = {};

  for (const segment of input.signatureHeader.split(",")) {
    const [key, ...rest] = segment.split("=");
    if (!key || rest.length === 0) {
      continue;
    }

    signatureParts[key] ??= [];
    signatureParts[key].push(rest.join("="));
  }

  const timestamp = signatureParts.t?.[0];
  const signatures = signatureParts.v1 ?? [];

  if (!timestamp || signatures.length === 0) {
    throw new AppError(401, "unauthorized", "Malformed Stripe signature header");
  }

  const currentUnixTime = input.now ?? Date.now();
  const ageSeconds = Math.abs(Math.floor(currentUnixTime / 1000) - Number(timestamp));
  const expected = createHmac("sha256", input.signingSecret)
    .update(`${timestamp}.${input.rawBody}`, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");

  const valid = signatures.some((signature) => {
    const receivedBuffer = Buffer.from(signature, "utf8");
    return (
      receivedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(receivedBuffer, expectedBuffer)
    );
  });

  if (!valid || ageSeconds > input.toleranceSeconds) {
    throw new AppError(401, "unauthorized", "Invalid Stripe signature");
  }

  const parsed = parseJsonObject(input.rawBody, "Unable to parse Stripe webhook payload");

  if (typeof parsed.id !== "string" || typeof parsed.type !== "string") {
    throw new AppError(400, "invalid_request", "Stripe webhook payload is missing event metadata");
  }

  return parsed as StripeEvent;
}

export function parseAsaasWebhookPayload(rawBody: string): AsaasPayload {
  return parseJsonObject(rawBody, "Unable to parse Asaas webhook payload");
}

export function extractAsaasExternalReference(payload: AsaasPayload): string {
  const payment =
    payload.payment && typeof payload.payment === "object" && !Array.isArray(payload.payment)
      ? (payload.payment as Record<string, unknown>)
      : undefined;
  const externalReference = payment?.externalReference ?? payload.externalReference;

  if (typeof externalReference !== "string" || externalReference.trim() === "") {
    throw new AppError(
      400,
      "invalid_request",
      "Webhook payload is missing externalReference",
    );
  }

  return externalReference.trim();
}

export function extractAsaasEventType(payload: AsaasPayload): string {
  const eventType = payload.event ?? payload.type;

  if (typeof eventType !== "string" || eventType.trim() === "") {
    return "payment";
  }

  return eventType.trim();
}
