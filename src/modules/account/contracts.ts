import type {Capability,OperationFeatures,Role} from '../tenancy/contracts.js';
export type RestaurantSummary={id:string;organizationId:string;name:string;slug:string;onboardingStatus:'draft'|'complete'};
export type Selection={organizationId:string;restaurantId:string};
export type AccountBootstrap={userId:string;organizations:{id:string;name:string;role:Role;capabilities:Capability[];features:OperationFeatures}[];
  restaurants:RestaurantSummary[];currentOrganizationId:string|null;currentRestaurantId:string|null;
  destination:'onboarding'|'select-restaurant'|'dashboard'};
export type RestaurantEntitlement={canCreate:boolean;reason:'allowed'|'permission'|'limit';count:number;limit:number};
