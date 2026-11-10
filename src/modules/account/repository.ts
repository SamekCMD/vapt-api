import {withTransaction,type Database} from '../../lib/database.js';
import {AppError} from '../../lib/errors.js';
import {authorizeOrganization,withRestaurantWrite} from '../tenancy/authorization.js';
import type {BillingPlanStatus,PlanType,Role,TenantActor,OrganizationScope} from '../tenancy/contracts.js';
import {getRestaurantLimit,hasCapability} from '../tenancy/policy.js';
import type {RestaurantSummary,Selection,RestaurantEntitlement} from './contracts.js';
export type AccountData={organizations:{id:string;name:string;role:Role;planType:PlanType;planStatus:BillingPlanStatus;trialEndsAt:string|null}[];
  restaurants:RestaurantSummary[];preference:Selection|null};
export interface AccountRepository{
  loadAccount(userId:string):Promise<AccountData>;
  savePreference(actor:TenantActor,selection:Selection):Promise<void>;
  getRestaurantEntitlement(scope:OrganizationScope):Promise<RestaurantEntitlement>;
}
function failure(error:unknown):never{
  if(error instanceof AppError)throw error;
  throw new AppError(500,'internal_error','Failed to load account');
}
export function createAccountRepository(database:Database):AccountRepository{
  return {
    async loadAccount(userId){try{
      // One statement/snapshot, no per-render counter requests or implicit preference writes.
      const result=await database.query<AccountData>(`with access as materialized(
        select organization_id,role from public.organization_members where user_id=$1::uuid and status='active'
          and role in ('owner','admin','manager','staff'))
        select coalesce((select jsonb_agg(jsonb_build_object('id',organization.id,'name',organization.name,'role',access.role,
          'planType',subscription.plan_type,'planStatus',subscription.plan_status,'trialEndsAt',subscription.trial_ends_at) order by organization.id)
          from access join public.organizations organization on organization.id=access.organization_id
          join public.organization_subscriptions subscription on subscription.organization_id=organization.id),'[]'::jsonb) organizations,
        coalesce((select jsonb_agg(jsonb_build_object('id',restaurant.id,'organizationId',restaurant.organization_id,
          'name',restaurant.name,'slug',restaurant.slug,'onboardingStatus',restaurant.onboarding_status) order by restaurant.created_at,restaurant.id)
          from public.restaurants restaurant join access on access.organization_id=restaurant.organization_id),'[]'::jsonb) restaurants,
        (select jsonb_build_object('organizationId',organization_id,'restaurantId',restaurant_id)
          from public.account_preferences where user_id=$1::uuid and restaurant_id is not null) preference`,[userId]);
      return result.rows[0]??{organizations:[],restaurants:[],preference:null};
    }catch(error){failure(error);}},
    async savePreference(actor,selection){try{
      await withRestaurantWrite(database,{...actor,restaurantId:selection.restaurantId},'restaurant.read',async client=>{
        const access=await authorizeOrganization(client,{userId:actor.userId,organizationId:selection.organizationId},'restaurant.read');
        const restaurant=(await client.query<{organization_id:string}>('select organization_id from public.restaurants where id=$1::uuid',[selection.restaurantId])).rows[0];
        if(restaurant?.organization_id!==access.organizationId)throw new AppError(403,'forbidden','Forbidden');
        await client.query(`insert into public.account_preferences(user_id,organization_id,restaurant_id) values($1,$2,$3)
          on conflict(user_id) do update set organization_id=excluded.organization_id,restaurant_id=excluded.restaurant_id`,
          [actor.userId,selection.organizationId,selection.restaurantId]);
      });
    }catch(error){failure(error);}},
    async getRestaurantEntitlement(scope){try{
      return await withTransaction(database,async client=>{
        const access=await authorizeOrganization(client,scope,'restaurant.read');
        const row=(await client.query<{plan_type:PlanType;plan_status:BillingPlanStatus;count:number}>(`select subscription.plan_type,subscription.plan_status,
          (select count(*)::int from public.restaurants where organization_id=$1::uuid) count
          from public.organization_subscriptions subscription where organization_id=$1::uuid`,[scope.organizationId])).rows[0];
        if(!row)throw new AppError(403,'forbidden','Forbidden');
        const limit=getRestaurantLimit(row.plan_status==='trialing'?'trial':row.plan_type),permitted=hasCapability(access.role,'restaurant.create');
        return {canCreate:permitted&&row.count<limit,reason:!permitted?'permission':row.count>=limit?'limit':'allowed',count:row.count,limit};
      });
    }catch(error){failure(error);}},
  };
}
