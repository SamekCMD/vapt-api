import {AppError} from '../../lib/errors.js';
import {validateWithSchema} from '../../lib/validation.js';
import type {Capability,OrganizationScope,TenantActor} from '../tenancy/contracts.js';
import {hasCapability,operationFeatures} from '../tenancy/policy.js';
import type {AccountBootstrap,Selection} from './contracts.js';
import type {AccountRepository} from './repository.js';
import {selectionSchema,uuidSchema} from './schemas.js';
const capabilities:Capability[]=['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'];
export function createAccountService(repository:AccountRepository){
  return {
    async getBootstrap(userId:string,routeRestaurantId?:string):Promise<AccountBootstrap>{
      userId=validateWithSchema(uuidSchema,userId);
      if(routeRestaurantId!==undefined)routeRestaurantId=validateWithSchema(uuidSchema,routeRestaurantId);
      const data=await repository.loadAccount(userId);
      const organizations=data.organizations.map(org=>({id:org.id,name:org.name,role:org.role,
        capabilities:capabilities.filter(capability=>hasCapability(org.role,capability)),
        features:operationFeatures(org.planType,org.planStatus,org.trialEndsAt,Date.now())}));
      const organizationsById=new Set(organizations.map(org=>org.id));
      const restaurants=data.restaurants.filter(restaurant=>organizationsById.has(restaurant.organizationId))
        .map(restaurant=>({id:restaurant.id,organizationId:restaurant.organizationId,name:restaurant.name,slug:restaurant.slug,onboardingStatus:restaurant.onboardingStatus}));
      let current=routeRestaurantId===undefined?undefined:restaurants.find(restaurant=>restaurant.id===routeRestaurantId);
      if(routeRestaurantId!==undefined&&!current)throw new AppError(403,'forbidden','Forbidden');
      if(!current&&data.preference)current=restaurants.find(restaurant=>restaurant.id===data.preference!.restaurantId&&restaurant.organizationId===data.preference!.organizationId);
      if(!current&&restaurants.length===1)current=restaurants[0];
      return {userId,organizations,restaurants,currentRestaurantId:current?.id??null,
        currentOrganizationId:current?.organizationId??(organizations.length===1?organizations[0].id:null),
        destination:current?(current.onboardingStatus==='complete'?'dashboard':'onboarding'):restaurants.length>1?'select-restaurant':'onboarding'};
    },
    savePreference(actor:TenantActor,selection:Selection){return repository.savePreference(actor,validateWithSchema(selectionSchema,selection));},
    getRestaurantEntitlement(scope:OrganizationScope){return repository.getRestaurantEntitlement(scope);},
  };
}
