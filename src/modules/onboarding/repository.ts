import type {PoolClient} from 'pg';
import {withTransaction,type Database,type Queryable} from '../../lib/database.js';
import {AppError} from '../../lib/errors.js';
import {validateWithSchema} from '../../lib/validation.js';
import type {RestaurantDto} from '../business/contracts.js';
import {createRestaurantRepository} from '../restaurants/repository.js';
import {authorizeRestaurant,withRestaurantWrite} from '../tenancy/authorization.js';
import {lockOperation,lockOrganization,lockSlugs} from '../tenancy/locks.js';
import type {RestaurantScope,RestaurantWriteScope,TenantActor} from '../tenancy/contracts.js';
import {tenantActorSchema} from '../tenancy/contracts.js';
import {uuidSchema} from '../account/schemas.js';
import type {DraftBasics,DraftPatch,GuideModule,OnboardingDraft} from './contracts.js';
import {draftBasicsSchema,draftPatchSchema,guideModuleSchema} from './schemas.js';
const columns=`id,organization_id as "organizationId",name,slug,coalesce(whatsapp,'') as whatsapp,
  local_enabled as "localEnabled",delivery_enabled as "deliveryEnabled",total_tables as "totalTables",onboarding_step as "onboardingStep"`;
const patchColumns={name:'name',slug:'slug',whatsapp:'whatsapp',localEnabled:'local_enabled',deliveryEnabled:'delivery_enabled',totalTables:'total_tables',onboardingStep:'onboarding_step'} as const;
function capturedActor(actor:TenantActor){
  if(!tenantActorSchema.safeParse(actor).success||actor.sessionExpiresAt<=Date.now())throw new AppError(401,'unauthorized','Unauthorized');
}
function failure(error:unknown):never{
  if(error instanceof AppError)throw error;
  const code=error&&typeof error==='object'&&'code' in error?error.code:null;
  if(code==='42501')throw new AppError(403,'forbidden','Forbidden');
  if(code==='P0401')throw new AppError(401,'unauthorized','Unauthorized');
  if(code==='P0400')throw new AppError(400,'invalid_request','Invalid request');
  if(code==='P0409'||code==='23505'||(code==='23514'&&'constraint' in (error as object)&&(error as {constraint:unknown}).constraint==='organization_restaurant_limit'))
    throw new AppError(409,'onboarding_conflict','Onboarding request conflicts');
  throw new AppError(500,'internal_error','Failed to persist onboarding');
}
async function draft(q:Queryable,restaurantId:string):Promise<OnboardingDraft>{
  const row=(await q.query<OnboardingDraft>(`select ${columns} from public.restaurants where id=$1::uuid`,[restaurantId])).rows[0];
  if(!row)throw new AppError(404,'not_found','Restaurant not found');return row;
}
export function createOnboardingRepository(database:Database,options:{transaction?:PoolClient}={}){
  const q=options.transaction??database;
  const transaction=<T>(work:(client:PoolClient)=>Promise<T>)=>options.transaction?work(options.transaction):withTransaction(database,work);
  const repository={
    async getDraft(scope:RestaurantScope){try{await authorizeRestaurant(q,scope,'restaurant.read');return await draft(q,scope.restaurantId);}catch(error){failure(error);}},
    async createInitialDraft(actor:TenantActor,key:string,input:DraftBasics){try{
      capturedActor(actor);
      const operationId=validateWithSchema(uuidSchema,key),basics=validateWithSchema(draftBasicsSchema,input);
      return await transaction(async client=>{
        const result=await client.query<{id:string}>(`select public.create_initial_restaurant_draft($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text) id`,
          [actor.userId,actor.sessionId,operationId,basics.name,basics.slug,basics.whatsapp??null]);
        return draft(client,result.rows[0]!.id);
      });
    }catch(error){failure(error);}},
    async createOrganizationDraft(actor:TenantActor,organizationId:string,key:string,input:DraftBasics){try{
      capturedActor(actor);
      const operationId=validateWithSchema(uuidSchema,key),org=validateWithSchema(uuidSchema,organizationId),basics=validateWithSchema(draftBasicsSchema,input);
      return await transaction(async client=>{
        const result=await client.query<{id:string}>(`select public.create_organization_restaurant_draft($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text) id`,
          [actor.userId,actor.sessionId,org,operationId,basics.name,basics.slug,basics.whatsapp??null]);
        return draft(client,result.rows[0]!.id);
      });
    }catch(error){failure(error);}},
    async saveDraft(actor:TenantActor,restaurantId:string,input:DraftPatch){try{
      const patch=validateWithSchema(draftPatchSchema,input),entries=Object.entries(patch) as [keyof DraftPatch,unknown][];
      return await withRestaurantWrite(database,{...actor,restaurantId},'restaurant.manage',async client=>{
        const result=await client.query<OnboardingDraft>(`update public.restaurants set ${entries.map(([key],index)=>`${patchColumns[key]}=$${index+2}`).join(',')},
          onboarding_updated_at=now() where id=$1::uuid and onboarding_status='draft' returning ${columns}`,[restaurantId,...entries.map(([,value])=>value)]);
        if(!result.rows[0])throw new AppError(409,'onboarding_complete','Onboarding is already complete');return result.rows[0];
      },{transaction:options.transaction,beforeSession:async client=>{
        if(patch.slug){const old=await draft(client,restaurantId);await lockSlugs(client,[old.slug,patch.slug]);}
      }});
    }catch(error){failure(error);}},
    async finalizeDraft(actor:TenantActor,restaurantId:string,key:string):Promise<RestaurantDto>{try{
      capturedActor(actor);
      const operationId=validateWithSchema(uuidSchema,key);
      return await transaction(async client=>{
        await lockOperation(client,operationId);
        const access=await authorizeRestaurant(client,{userId:actor.userId,restaurantId},'restaurant.manage');
        // Finalization can start the organization's trial. Never upgrade a shared org lock after taking a restaurant lock.
        await lockOrganization(client,access.organizationId,'exclusive');
        return withRestaurantWrite(database,{...actor,restaurantId},'restaurant.manage',async()=>{
          await client.query('select public.finalize_restaurant_onboarding($1::uuid,$2::uuid,$3::uuid,$4::uuid)',[actor.userId,actor.sessionId,restaurantId,operationId]);
          const completed=await createRestaurantRepository(database,{transaction:client}).getRestaurant({userId:actor.userId,restaurantId});
          if(!completed)throw new AppError(404,'not_found','Restaurant not found');return completed;
        },{transaction:client});
      });
    }catch(error){failure(error);}},
    async getActivation(scope:RestaurantScope):Promise<Record<GuideModule,boolean>>{try{
      await authorizeRestaurant(q,scope,'restaurant.read');
      const rows=(await q.query<{module:GuideModule}>('select module from public.restaurant_activation_progress where restaurant_id=$1::uuid',[scope.restaurantId])).rows;
      return {cashier:rows.some(row=>row.module==='cashier'),menu:rows.some(row=>row.module==='menu'),kitchen:rows.some(row=>row.module==='kitchen'),
        settings:rows.some(row=>row.module==='settings'),overview:rows.some(row=>row.module==='overview')};
    }catch(error){failure(error);}},
    async completeActivation(scope:RestaurantWriteScope,module:GuideModule){try{
      module=validateWithSchema(guideModuleSchema,module);
      await withRestaurantWrite(database,scope,'restaurant.operate',async client=>{
        await client.query(`insert into public.restaurant_activation_progress(restaurant_id,module,completed_by) values($1::uuid,$2::text,$3::uuid)
          on conflict(restaurant_id,module) do nothing`,[scope.restaurantId,module,scope.userId]);
      },{transaction:options.transaction});
    }catch(error){failure(error);}},
  };
  return repository;
}
export type OnboardingRepository=ReturnType<typeof createOnboardingRepository>;
