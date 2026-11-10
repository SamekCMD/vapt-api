import type {Hono,MiddlewareHandler} from 'hono';
import {z} from 'zod';
import {AppError} from '../../lib/errors.js';
import {validateWithSchema} from '../../lib/validation.js';
import {actorFromAuth} from '../../plugins/auth.js';
import {bootstrapQuerySchema,selectionSchema,organizationParamsSchema,uuidSchema} from '../../modules/account/schemas.js';
import {restaurantParamsSchema} from '../../modules/restaurants/schemas.js';
import {draftBasicsSchema,draftPatchSchema,guideModuleSchema} from '../../modules/onboarding/schemas.js';
import type {WorkerHonoEnv} from '../app.js';
import type {Context} from 'hono';
import {parseWorkerJson,readWorkerBody,requireWorkerAuth,workerRateLimit} from '../http.js';
import {isCatalogWriterEnabled,respondCatalogMutation,submitCatalogMutation} from '../catalog/writer.js';
const moduleParams=restaurantParamsSchema.extend({module:guideModuleSchema});
const emptyBody=z.object({}).strict();
async function validateEmptyAction(context:Context<WorkerHonoEnv>){
  // Workerd can expose an empty stream for a bodyless POST; body!==null is not a length check.
  const raw=await readWorkerBody(context.req.raw,new AppError(400,'invalid_request','Invalid request'));
  if(!raw)return;
  if(!/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type')??''))throw new AppError(400,'invalid_request','Invalid request');
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new AppError(400,'invalid_request','Invalid request');}
  validateWithSchema(emptyBody,value);
}
export function registerWorkerAccountRoutes(app:Hono<WorkerHonoEnv>,options:{rateLimit?:boolean}={}){
  const rate:MiddlewareHandler<WorkerHonoEnv>=options.rateLimit===false?async(_context,next)=>next():workerRateLimit('auth');
  const auth:MiddlewareHandler<WorkerHonoEnv>=async(context,next)=>{
    context.header('cache-control','no-store');
    await requireWorkerAuth(context);
    context.set('catalogActor',actorFromAuth(context.get('auth'))); // Same verified request; no second auth SQL lookup.
    await next();
  };
  app.get('/account/bootstrap',rate,auth,async context=>{
    const query=validateWithSchema(bootstrapQuerySchema,context.req.query()),services=await context.get('getServices')();
    return context.json(await services.account.getBootstrap(context.get('auth').userId,query.restaurantId));
  });
  app.patch('/account/preference',rate,auth,async context=>{
    const input=validateWithSchema(selectionSchema,await parseWorkerJson(context.req.raw)),services=await context.get('getServices')();
    await services.account.savePreference(actorFromAuth(context.get('auth')),input);return context.body(null,204);
  });
  app.get('/organizations/:organizationId/restaurant-entitlement',rate,auth,async context=>{
    const {organizationId}=validateWithSchema(organizationParamsSchema,context.req.param()),services=await context.get('getServices')();
    return context.json(await services.account.getRestaurantEntitlement({userId:context.get('auth').userId,organizationId}));
  });
  app.post('/account/onboarding-draft',rate,auth,async context=>{
    const input=validateWithSchema(draftBasicsSchema,await parseWorkerJson(context.req.raw)),key=validateWithSchema(uuidSchema,context.req.header('Idempotency-Key'));
    const services=await context.get('getServices')();return context.json(await services.onboarding.createInitialDraft(actorFromAuth(context.get('auth')),key,input),201);
  });
  app.post('/organizations/:organizationId/restaurants/drafts',rate,auth,async context=>{
    const {organizationId}=validateWithSchema(organizationParamsSchema,context.req.param()),key=validateWithSchema(uuidSchema,context.req.header('Idempotency-Key'));
    const input=validateWithSchema(draftBasicsSchema,await parseWorkerJson(context.req.raw)),services=await context.get('getServices')();
    return context.json(await services.onboarding.createOrganizationDraft(actorFromAuth(context.get('auth')),organizationId,key,input),201);
  });
  app.get('/restaurants/:restaurantId/onboarding',rate,auth,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param()),services=await context.get('getServices')();
    return context.json(await services.onboarding.getDraft({userId:context.get('auth').userId,restaurantId}));
  });
  app.patch('/restaurants/:restaurantId/onboarding',rate,auth,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param()),input=validateWithSchema(draftPatchSchema,await parseWorkerJson(context.req.raw));
    const services=await context.get('getServices')();return context.json(await services.onboarding.saveDraft(actorFromAuth(context.get('auth')),restaurantId,input));
  });
  app.post('/restaurants/:restaurantId/onboarding/finalize',rate,auth,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param()),key=validateWithSchema(uuidSchema,context.req.header('Idempotency-Key'));
    await validateEmptyAction(context);
    if(isCatalogWriterEnabled(context.env))return respondCatalogMutation(context,await submitCatalogMutation(context,{type:'onboarding.finalize',input:{restaurantId}},restaurantId),200);
    const services=await context.get('getServices')();return context.json(await services.onboarding.finalizeDraft(actorFromAuth(context.get('auth')),restaurantId,key));
  });
  app.get('/restaurants/:restaurantId/activation',rate,auth,async context=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,context.req.param()),services=await context.get('getServices')();
    return context.json(await services.onboarding.getActivation({userId:context.get('auth').userId,restaurantId}));
  });
  app.post('/restaurants/:restaurantId/activation/:module',rate,auth,async context=>{
    const {restaurantId,module}=validateWithSchema(moduleParams,context.req.param()),services=await context.get('getServices')();
    await validateEmptyAction(context);
    await services.onboarding.completeActivation({...actorFromAuth(context.get('auth')),restaurantId},module);return context.body(null,204);
  });
}
