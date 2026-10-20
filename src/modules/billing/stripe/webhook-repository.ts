import { withTransaction, type Database, type Queryable } from "../../../lib/database.js";
import { AppError } from "../../../lib/errors.js";
import {bindBillingResource,type LegacyBillingResource,type StripePlanStatus} from "./repository.js";
import type { StripePlanType } from "./schemas.js";

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
  organizationId: string;
  restaurantId: string | null;
  providerEventId: string;
  emailKind: BillingEmailKind;
  billingResourceId: string;
  payload: Record<string, unknown>;
};
export type ReconciliationScope = { organizationId:string;billingContactUserId:string;legacyResources:LegacyBillingResource[];
  restaurantId:string|null;claim:BillingClaimToken;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null;
  checkoutSessionId: string | null; planStatus: StripePlanStatus; stateUpdatedAt: string | null;
};
export type SubscriptionReconciliation = {
  customerId: string; subscriptionId: string; subscriptionItemId: string;
  planType: StripePlanType; planStatus: StripePlanStatus; trialEndsAt: string | null;
  currentPeriodEnd: string; cancelAtPeriodEnd: boolean; subscriptionCanceledAt: string | null;
  observedAt: string; checkoutSessionId: string | null; billingLastError: string | null;
};

export interface StripeWebhookRepository {
  claimEvent(input: BillingEventInput): Promise<BillingEventClaim>;
  markFailed(input: BillingClaimToken & { errorCode: string }): Promise<void>;
  withClaimedEvent(input: BillingClaimToken,
    work: (transaction: Queryable) => Promise<"processed" | "ignored">): Promise<void>;
  enqueueEmail(transaction: Queryable, input: BillingEmailIntent): Promise<void>;
  resolveOrganization(transaction: Queryable, input: {
    organizationId:string|null; subscriptionId:string|null;customerId:string|null;restaurantId:string|null;
    checkoutSessionId:string|null;claim:BillingClaimToken;
  }): Promise<ReconciliationScope | null>;
  applySubscription(transaction: Queryable, scope: ReconciliationScope, input: SubscriptionReconciliation): Promise<boolean>;
  clearPendingCheckout(transaction: Queryable, scope: ReconciliationScope, sessionId: string): Promise<boolean>;
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
    async resolveOrganization(transaction,input) {
      try {
        const conflict=()=>{throw new AppError(409,"billing_association_conflict","Billing resource association conflicts");};
        const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        if(input.organizationId && !uuid.test(input.organizationId)) conflict();
        if(input.restaurantId && !uuid.test(input.restaurantId)) conflict();
        const references=[input.customerId,input.subscriptionId,input.checkoutSessionId].filter((v):v is string=>v!==null);
        const resources=await transaction.query<{resource_id:string;resource_type:string;organization_id:string}>(
          'select resource_id,resource_type,organization_id from public.organization_billing_resources where resource_id=any($1::text[])',[references]);
        for(const resource of resources.rows){
          const expected=resource.resource_id===input.customerId?'customer':resource.resource_id===input.subscriptionId?'subscription':'checkout';
          if(resource.resource_type!==expected)conflict();
        }
        const candidates=new Set(resources.rows.map(row=>row.organization_id));
        if(input.organizationId){
          const org=await transaction.query<{id:string}>('select id from public.organizations where id=$1::uuid',[input.organizationId]);
          if(!org.rows[0]){if(candidates.size)conflict();return null;}
          candidates.add(org.rows[0].id);
        }
        if(input.restaurantId){
          const legacy=await transaction.query<{organization_id:string}>('select organization_id from public.restaurants where id=$1::uuid',[input.restaurantId]);
          if(!legacy.rows[0]){if(candidates.size)conflict();return null;}
          candidates.add(legacy.rows[0].organization_id);
        }
        const existing=await transaction.query<{organization_id:string|null}>(
          "select organization_id from public.billing_provider_events where provider='stripe' and provider_event_id=$1::text and attempt_count=$2::integer",
          [input.claim.providerEventId,input.claim.attemptCount]);
        if(existing.rows[0]?.organization_id)candidates.add(existing.rows[0].organization_id);
        if(candidates.size>1)conflict();
        const organizationId=[...candidates][0];if(!organizationId)return null;
        await transaction.query('select pg_advisory_xact_lock(hashtextextended($1::text,0))',[`tenant:organization:${organizationId}`]);
        const result=await transaction.query<Omit<ReconciliationScope,'claim'|'restaurantId'>>(`select organization_id as "organizationId",
          billing_contact_user_id as "billingContactUserId",stripe_customer_id as "stripeCustomerId",
          stripe_subscription_id as "stripeSubscriptionId",stripe_checkout_session_id as "checkoutSessionId",
          plan_status as "planStatus",stripe_state_updated_at as "stateUpdatedAt",
          coalesce((select jsonb_agg(jsonb_build_object('resourceId',resource_id,'resourceType',resource_type,
            'restaurantId',restaurant_id,'legacyOwnerId',legacy_owner_id) order by resource_id)
            from public.organization_billing_legacy_resources where organization_id=$1::uuid),'[]'::jsonb) as "legacyResources"
          from public.organization_subscriptions where organization_id=$1::uuid for update`,[organizationId]);
        const row=result.rows[0];if(!row)conflict();
        const bound=await transaction.query(`update public.billing_provider_events set organization_id=$3::uuid
          where provider='stripe' and provider_event_id=$1::text and attempt_count=$2::integer
            and processing_status='processing' and (organization_id is null or organization_id=$3::uuid) returning id`,
          [input.claim.providerEventId,input.claim.attemptCount,organizationId]);
        if(!bound.rows[0])throw new AppError(409,"billing_claim_lost","Stripe event claim is no longer owned");
        return {...row,claim:input.claim,restaurantId:input.restaurantId,
          stateUpdatedAt:row.stateUpdatedAt===null?null:new Date(row.stateUpdatedAt).toISOString()};
      }catch(error){storageError(error);}
    },
    async applySubscription(transaction,scope,input) {
      try{
        await bindBillingResource(transaction,scope.organizationId,input.customerId,'customer');
        await bindBillingResource(transaction,scope.organizationId,input.subscriptionId,'subscription');
        const result=await transaction.query<{applied:boolean}>(`select public.reconcile_organization_subscription(
          $1::uuid,$2::text,$3::integer,$4::text,$5::text,$6::text,$7::text,$8::text,$9::timestamptz,
          $10::timestamptz,$11::boolean,$12::timestamptz,$13::timestamptz,$14::text,$15::text) applied`,
          [scope.organizationId,scope.claim.providerEventId,scope.claim.attemptCount,input.customerId,input.subscriptionId,
            input.subscriptionItemId,input.planType,input.planStatus,input.trialEndsAt,input.currentPeriodEnd,
            input.cancelAtPeriodEnd,input.subscriptionCanceledAt,input.observedAt,input.checkoutSessionId,input.billingLastError]);
        return result.rows[0]?.applied===true;
      }catch(error){storageError(error);}
    },
    async clearPendingCheckout(transaction,scope,sessionId){
      try{
        const result=await transaction.query(`update public.organization_subscriptions set stripe_checkout_session_id=null,
          stripe_checkout_plan_type=null,stripe_checkout_expires_at=null where organization_id=$1::uuid
          and stripe_checkout_session_id=$2::text and exists(select 1 from public.billing_provider_events
            where provider='stripe' and provider_event_id=$3::text and attempt_count=$4::integer and processing_status='processing'
              and organization_id=$1::uuid) returning organization_id`,
          [scope.organizationId,sessionId,scope.claim.providerEventId,scope.claim.attemptCount]);
        return result.rows.length===1;
      }catch(error){storageError(error);}
    },
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
          organization_id, restaurant_id, provider_event_id, email_kind, payload, billing_resource_id
        ) values ($1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb, $6::text)
        on conflict do nothing`,
        [input.organizationId, input.restaurantId, input.providerEventId, input.emailKind, JSON.stringify(input.payload), input.billingResourceId]);
      } catch (error) { storageError(error); }
    },
  };
}
