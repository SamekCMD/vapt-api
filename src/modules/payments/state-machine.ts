import type { PaymentStatus } from "./types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  created: new Set(["pending", "processing", "paid", "failed", "cancelled"]),
  pending: new Set(["processing", "paid", "failed", "cancelled"]),
  processing: new Set(["pending", "paid", "failed", "cancelled"]),
  paid: new Set(["refunded"]),
  failed: new Set(),
  cancelled: new Set(),
  refunded: new Set(),
};

export class InvalidPaymentTransitionError extends Error {
  constructor(
    public readonly currentStatus: PaymentStatus,
    public readonly nextStatus: PaymentStatus,
  ) {
    super(`Invalid payment transition: ${currentStatus} -> ${nextStatus}`);
    this.name = "InvalidPaymentTransitionError";
  }
}

export function isPaymentTransitionAllowed(
  currentStatus: PaymentStatus,
  nextStatus: PaymentStatus,
): boolean {
  if (currentStatus === nextStatus) {
    return true;
  }

  return ALLOWED_TRANSITIONS[currentStatus].has(nextStatus);
}

export function assertPaymentTransition(
  currentStatus: PaymentStatus,
  nextStatus: PaymentStatus,
): void {
  if (!isPaymentTransitionAllowed(currentStatus, nextStatus)) {
    throw new InvalidPaymentTransitionError(currentStatus, nextStatus);
  }
}
