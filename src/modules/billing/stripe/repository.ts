import {withTransaction,type Database,type Queryable} from '../../../lib/database.js';
import {AppError} from '../../../lib/errors.js';
import {authorizeOrganization,authorizeRestaurant,assertLiveSession} from '../../tenancy/authorization.js';
import {lockOrganization} from '../../tenancy/locks.js';
import type {OrganizationScope,OrganizationWriteScope,Capability,Role} from '../../tenancy/contracts.js';
import type {StripePlanType} from './schemas.js';

export type StripePlanStatus='trialing'|'active'|'past_due'|'incomplete'|'unpaid'|'paused'|'expired'|'cancelled';
// Legacy origin is metadata validation context only, never an authorization scope.
export type LegacyBillingResource={resourceId:string;resourceType:'customer'|'subscription'|'checkout';restaurantId:string;legacyOwnerId:string};
export type BillingScope=OrganizationScope&{
  billingContactUserId:string;billingContactEmail:string|null;role:Role;legacyResources:LegacyBillingResource[];
  planType:StripePlanType;planStatus:StripePlanStatus;stripeCustomerId:string|null;stripeSubscriptionId:string|null;
  trialEndsAt:string|null;currentPeriodEnd:string|null;cancelAtPeriodEnd:boolean;subscriptionCanceledAt:string|null;
  checkoutSessionId:string|null;checkoutPlanType:StripePlanType|null;checkoutExpiresAt:string|null;
};
export type PublicBillingStatus=Pick<BillingScope,'planType'|'planStatus'|'trialEndsAt'|'currentPeriodEnd'|'cancelAtPeriodEnd'|'subscriptionCanceledAt'>
  &{canManageBilling:boolean;canStartCheckout:boolean;requiresBillingAction:boolean};
export type PendingCheckout={id:string;planType:StripePlanType;expiresAt:string};
export type BillingLock={scope:BillingScope;associateCustomer(customerId:string):Promise<void>;
  savePendingCheckout(checkout:PendingCheckout):Promise<void>;clearPendingCheckout():Promise<void>};
export interface StripeBillingStore{
  getScope(input:OrganizationScope):Promise<BillingScope>;
  getPublicStatus(input:OrganizationScope):Promise<PublicBillingStatus>;
  withBillingLock<T>(input:OrganizationWriteScope,work:(lock:BillingLock)=>Promise<T>):Promise<T>;
}
export async function resolveBillingOrganization(database:Queryable,input:{userId:string;organizationId?:string;restaurantId?:string},
  capability:Capability):Promise<OrganizationScope>{
  let organizationId=input.organizationId;
  if(input.restaurantId){
    const access=await authorizeRestaurant(database,{userId:input.userId,restaurantId:input.restaurantId},capability);
    if(organizationId && organizationId.toLowerCase()!==access.organizationId) throw new AppError(400,'billing_scope_conflict','Billing scope does not match');
    organizationId=access.organizationId;
  }
  if(!organizationId) throw new AppError(400,'invalid_request','Organization or restaurant is required');
  const scope={userId:input.userId,organizationId:organizationId.toLowerCase()};
  await authorizeOrganization(database,scope,capability);return scope;
}
const scopeSql=`select subscription.organization_id as "organizationId",member.user_id as "userId",member.role,
  subscription.billing_contact_user_id as "billingContactUserId",
  case when contact."emailVerified" then contact.email else null end as "billingContactEmail",
  subscription.plan_type as "planType",subscription.plan_status as "planStatus",
  subscription.stripe_customer_id as "stripeCustomerId",subscription.stripe_subscription_id as "stripeSubscriptionId",
  subscription.trial_ends_at as "trialEndsAt",subscription.stripe_current_period_end as "currentPeriodEnd",
  subscription.stripe_cancel_at_period_end as "cancelAtPeriodEnd",subscription.subscription_canceled_at as "subscriptionCanceledAt",
  subscription.stripe_checkout_session_id as "checkoutSessionId",subscription.stripe_checkout_plan_type as "checkoutPlanType",
  subscription.stripe_checkout_expires_at as "checkoutExpiresAt",
  coalesce((select jsonb_agg(jsonb_build_object('resourceId',legacy.resource_id,'resourceType',legacy.resource_type,
    'restaurantId',legacy.restaurant_id,'legacyOwnerId',legacy.legacy_owner_id) order by legacy.resource_id)
    from public.organization_billing_legacy_resources legacy where legacy.organization_id=subscription.organization_id),'[]'::jsonb) as "legacyResources"
  from public.organization_subscriptions subscription
  join public.organization_members member on member.organization_id=subscription.organization_id
  join better_auth."user" contact on contact.id=subscription.billing_contact_user_id
  where subscription.organization_id=$1::uuid and member.user_id=$2::uuid and member.status='active'
    and member.role in ('owner','admin','manager')`;
const iso=(value:string|Date|null)=>value===null?null:new Date(value).toISOString();
async function readScope(q:Queryable,input:OrganizationScope,locked=false):Promise<BillingScope>{
  const result=await q.query<BillingScope>(scopeSql+(locked?' for update of subscription':''),[input.organizationId,input.userId]);
  const row=result.rows[0];if(!row) throw new AppError(403,'forbidden','Forbidden');
  return {...row,trialEndsAt:iso(row.trialEndsAt),currentPeriodEnd:iso(row.currentPeriodEnd),
    subscriptionCanceledAt:iso(row.subscriptionCanceledAt),checkoutExpiresAt:iso(row.checkoutExpiresAt)};
}
export function billingStorageError(error:unknown):never{
  if(error instanceof AppError) throw error;
  if(typeof error==='object' && error!==null && 'code' in error && error.code==='23505')
    throw new AppError(409,'billing_conflict','Stripe resource is already associated');
  throw new AppError(500,'internal_error','Failed to persist Stripe billing state');
}
export async function bindBillingResource(q:Queryable,organizationId:string,resourceId:string,resourceType:LegacyBillingResource['resourceType']):Promise<void>{
  await q.query(`insert into public.organization_billing_resources(resource_id,resource_type,organization_id)
    values($1::text,$2::text,$3::uuid) on conflict(resource_id) do nothing`,[resourceId,resourceType,organizationId]);
  const result=await q.query<{organization_id:string;resource_type:string}>(
    'select organization_id,resource_type from public.organization_billing_resources where resource_id=$1::text',[resourceId]);
  if(result.rows[0]?.organization_id!==organizationId || result.rows[0]?.resource_type!==resourceType)
    throw new AppError(409,'billing_association_conflict','Stripe resource association conflicts');
}
async function update(q:Queryable,input:OrganizationScope,assignments:string,values:unknown[]=[]){
  const saved=await q.query(`update public.organization_subscriptions set ${assignments}
    where organization_id=$1::uuid and exists(select 1 from public.organization_members member
      where member.organization_id=$1::uuid and member.user_id=$2::uuid and member.status='active' and member.role in ('owner','admin'))
    returning organization_id`,[input.organizationId,input.userId,...values]);
  if(!saved.rows[0]) throw new AppError(403,'forbidden','Forbidden');
}
export function createStripeBillingRepository(database:Database):StripeBillingStore{
  return {
    async getScope(input){try{
      await authorizeOrganization(database,input,'billing.read');return await readScope(database,input);
    }catch(error){billingStorageError(error);}},
    async getPublicStatus(input){try{
      await authorizeOrganization(database,input,'billing.read');const scope=await readScope(database,input);
      const manages=scope.role==='owner'||scope.role==='admin';
      return {planType:scope.planType,planStatus:scope.planStatus,trialEndsAt:scope.trialEndsAt,currentPeriodEnd:scope.currentPeriodEnd,
        cancelAtPeriodEnd:scope.cancelAtPeriodEnd,subscriptionCanceledAt:scope.subscriptionCanceledAt,
        canManageBilling:manages && scope.stripeCustomerId!==null,
        canStartCheckout:manages && (scope.stripeSubscriptionId===null || ['expired','cancelled'].includes(scope.planStatus)),
        requiresBillingAction:['past_due','incomplete','unpaid','paused'].includes(scope.planStatus)};
    }catch(error){billingStorageError(error);}},
    async withBillingLock(input,work){try{
      return await withTransaction(database,async client=>{
        await authorizeOrganization(client,input,'billing.manage');
        await lockOrganization(client,input.organizationId,'exclusive');
        await authorizeOrganization(client,input,'billing.manage');await assertLiveSession(client,input);
        const scope=await readScope(client,input,true);
        return work({scope,
          async associateCustomer(customerId){
            if(scope.stripeCustomerId && scope.stripeCustomerId!==customerId) throw new AppError(409,'billing_conflict','Customer is already associated');
            await bindBillingResource(client,input.organizationId,customerId,'customer');
            await update(client,input,'stripe_customer_id=$3::text',[customerId]);scope.stripeCustomerId=customerId;
          },
          async savePendingCheckout(checkout){
            await bindBillingResource(client,input.organizationId,checkout.id,'checkout');
            await update(client,input,'stripe_checkout_session_id=$3::text,stripe_checkout_plan_type=$4::text,stripe_checkout_expires_at=$5::timestamptz',
              [checkout.id,checkout.planType,checkout.expiresAt]);
            scope.checkoutSessionId=checkout.id;scope.checkoutPlanType=checkout.planType;scope.checkoutExpiresAt=checkout.expiresAt;
          },
          async clearPendingCheckout(){
            await update(client,input,'stripe_checkout_session_id=null,stripe_checkout_plan_type=null,stripe_checkout_expires_at=null');
            scope.checkoutSessionId=null;scope.checkoutPlanType=null;scope.checkoutExpiresAt=null;
          },
        });
      });
    }catch(error){billingStorageError(error);}},
  };
}
