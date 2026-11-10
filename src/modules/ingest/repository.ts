import type { Database } from '../../lib/database.js';
import { AppError } from '../../lib/errors.js';
import { legacyWriteActor,resolveLegacyRestaurant,withRestaurantWrite } from '../tenancy/authorization.js';
import type { RestaurantWriteScope,TenantActor } from '../tenancy/contracts.js';
import type { PushSubscriptionBody } from './schemas.js';

export type PushSubscriptionResult={ restaurantId:string;endpoint:string;status:'subscribed' };
export interface PushSubscriptionRepository {
  upsertSubscription(scope:RestaurantWriteScope,input:PushSubscriptionBody):Promise<PushSubscriptionResult>;
  upsertOwnedSubscription(userId:string,input:PushSubscriptionBody,actor?:TenantActor):Promise<PushSubscriptionResult>;
}
export function createPushSubscriptionRepository(database:Database):PushSubscriptionRepository {
  const repository:PushSubscriptionRepository={
    async upsertSubscription(scope,input) {
      try {
        return await withRestaurantWrite(database,scope,'restaurant.operate',async client=>{
          const result=await client.query<{restaurant_id:string;endpoint:string}>(`insert into public.push_subscriptions
            (restaurant_id,endpoint,subscription,origin,user_agent)
            select $1::uuid,$2::text,$3::jsonb,$4::text,$5::text where exists(select 1 from public.restaurants restaurant
              join public.organization_members member on member.organization_id=restaurant.organization_id
              where restaurant.id=$1::uuid and member.user_id=$6::uuid and member.status='active')
            on conflict(endpoint) do update set subscription=excluded.subscription,origin=excluded.origin,
              user_agent=excluded.user_agent,updated_at=now()
              where public.push_subscriptions.restaurant_id=excluded.restaurant_id
            returning restaurant_id,endpoint`,
          [scope.restaurantId,input.endpoint,input.subscription,input.origin,input.user_agent,scope.userId]);
          const row=result.rows[0];
          if(!row) throw new AppError(409,'push_subscription_conflict','Push subscription could not be associated with restaurant');
          return { restaurantId:row.restaurant_id,endpoint:row.endpoint,status:'subscribed' };
        });
      } catch(error) { if(error instanceof AppError) throw error; throw new AppError(500,'internal_error','Failed to persist push subscription'); }
    },
    async upsertOwnedSubscription(userId,input,actor) {
      const verified=legacyWriteActor(userId,actor);
      return repository.upsertSubscription({...verified,...await resolveLegacyRestaurant(database,userId)},input);
    },
  };
  return repository;
}
