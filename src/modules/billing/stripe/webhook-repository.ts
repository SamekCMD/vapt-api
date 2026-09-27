import { withTransaction, type Database, type Queryable } from "../../../lib/database.js";
import { AppError } from "../../../lib/errors.js";

export type BillingEventClaim =
  | { kind: "claimed"; attemptCount: number }
  | { kind: "duplicate_processed" }
  | { kind: "in_flight" };

export type BillingEventInput = {
  providerEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type BillingClaimToken = { providerEventId: string; attemptCount: number };
export type BillingEmailKind =
  | "subscription_activated" | "subscription_renewed" | "payment_failed" | "subscription_cancelled";
export type BillingEmailIntent = {
  restaurantId: string;
  providerEventId: string;
  emailKind: BillingEmailKind;
  payload: Record<string, unknown>;
};

export interface StripeWebhookRepository {
  claimEvent(input: BillingEventInput): Promise<BillingEventClaim>;
  markFailed(input: BillingClaimToken & { errorCode: string }): Promise<void>;
  withClaimedEvent(input: BillingClaimToken,
    work: (transaction: Queryable) => Promise<"processed" | "ignored">): Promise<void>;
  enqueueEmail(transaction: Queryable, input: BillingEmailIntent): Promise<void>;
}

function storageError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError(500, "internal_error", "Failed to persist Stripe webhook state");
}

export function createStripeWebhookRepository(
  database: Database,
  options: { now?: () => Date; leaseMs?: number } = {},
): StripeWebhookRepository {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 60000;
  return {
    async claimEvent(input) {
      try {
        const claimedAt = now();
        const result = await database.query<{ attemptCount: number }>(
          `insert into public.billing_provider_events as event (
            provider, provider_event_id, event_type, payload,
            processing_status, attempt_count, processing_started_at
          ) values ('stripe', $1::text, $2::text, $3::jsonb, 'processing', 1, $4::timestamptz)
          on conflict (provider, provider_event_id) do update
            set processing_status = 'processing',
                attempt_count = event.attempt_count + 1,
                processing_started_at = $4::timestamptz,
                processed_at = null, last_error = null
          where event.processing_status in ('received', 'pending_retry')
             or (event.processing_status = 'processing'
                 and event.processing_started_at <= $5::timestamptz)
          returning attempt_count as "attemptCount"`,
          [input.providerEventId, input.eventType, JSON.stringify(input.payload),
            claimedAt.toISOString(), new Date(claimedAt.getTime() - leaseMs).toISOString()],
        );
        if (result.rows[0]) return { kind: "claimed", attemptCount: result.rows[0].attemptCount };

        const existing = await database.query<{ processingStatus: string }>(
          `select processing_status as "processingStatus" from public.billing_provider_events
           where provider = 'stripe' and provider_event_id = $1::text`, [input.providerEventId],
        );
        const status = existing.rows[0]?.processingStatus;
        if (status === "processed" || status === "ignored") return { kind: "duplicate_processed" };
        if (status === "processing") return { kind: "in_flight" };
        throw new AppError(500, "billing_claim_failed", "Stripe event could not be claimed");
      } catch (error) { storageError(error); }
    },

    async markFailed(input) {
      try {
        // Error codes are owned by the reducer. Arbitrary exception text never reaches storage.
        const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(input.errorCode)
          ? input.errorCode : "billing_processing_failed";
        await database.query(`update public.billing_provider_events
          set processing_status = 'pending_retry', processing_started_at = null,
              processed_at = null, last_error = $3::text
          where provider = 'stripe' and provider_event_id = $1::text
            and attempt_count = $2::integer and processing_status = 'processing'`,
          [input.providerEventId, input.attemptCount, safeCode]);
      } catch (error) { storageError(error); }
    },

    async withClaimedEvent(input, work) {
      try {
        await withTransaction(database, async (client) => {
          const result = await client.query<{ attemptCount: number; processingStatus: string }>(
            `select attempt_count as "attemptCount", processing_status as "processingStatus"
             from public.billing_provider_events
             where provider = 'stripe' and provider_event_id = $1::text for update`,
            [input.providerEventId],
          );
          const claim = result.rows[0];
          if (!claim || claim.attemptCount !== input.attemptCount || claim.processingStatus !== "processing") {
            throw new AppError(409, "billing_claim_lost", "Stripe event claim is no longer owned");
          }
          const status = await work(client);
          if (status !== "processed" && status !== "ignored") {
            throw new AppError(500, "billing_processing_failed", "Invalid Stripe processing outcome");
          }
          await client.query(`update public.billing_provider_events
            set processing_status = $3::text, processed_at = $4::timestamptz,
                processing_started_at = null, last_error = null
            where provider = 'stripe' and provider_event_id = $1::text
              and attempt_count = $2::integer and processing_status = 'processing'`,
            [input.providerEventId, input.attemptCount, status, now().toISOString()]);
        });
      } catch (error) { storageError(error); }
    },

    async enqueueEmail(transaction, input) {
      try {
        await transaction.query(`insert into public.billing_email_outbox (
          restaurant_id, provider_event_id, email_kind, payload
        ) values ($1::uuid, $2::text, $3::text, $4::jsonb)
        on conflict (provider_event_id, email_kind) do nothing`,
        [input.restaurantId, input.providerEventId, input.emailKind, JSON.stringify(input.payload)]);
      } catch (error) { storageError(error); }
    },
  };
}
