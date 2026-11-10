import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {actorFromAuth,requireAuth} from '../../plugins/auth.js';
import {validateWithSchema} from '../../lib/validation.js';
import {organizationParamsSchema,uuidSchema} from '../account/schemas.js';
import {restaurantParamsSchema} from '../restaurants/schemas.js';
import type {createOnboardingService} from './service.js';
import {draftBasicsSchema,draftPatchSchema,guideModuleSchema} from './schemas.js';
const activationParams=restaurantParamsSchema.extend({module:guideModuleSchema});
const emptyBody=z.object({}).strict().optional();
export async function registerOnboardingRoutes(app:FastifyInstance,service:ReturnType<typeof createOnboardingService>){
  const options={config:{rateLimitGroup:'auth' as const},preHandler:async(request:Parameters<typeof requireAuth>[0],reply:Parameters<typeof requireAuth>[1])=>{
    reply.header('Cache-Control','no-store');await requireAuth(request,reply,app.authSessionResolver);
  }};
  app.post('/account/onboarding-draft',options,async(request,reply)=>{
    const input=validateWithSchema(draftBasicsSchema,request.body),key=validateWithSchema(uuidSchema,request.headers['idempotency-key']);
    const result=await service.createInitialDraft(actorFromAuth(request.auth!),key,input);return reply.status(201).send(result);
  });
  app.post('/organizations/:organizationId/restaurants/drafts',options,async(request,reply)=>{
    const {organizationId}=validateWithSchema(organizationParamsSchema,request.params),key=validateWithSchema(uuidSchema,request.headers['idempotency-key']);
    const result=await service.createOrganizationDraft(actorFromAuth(request.auth!),organizationId,key,validateWithSchema(draftBasicsSchema,request.body));return reply.status(201).send(result);
  });
  app.get('/restaurants/:restaurantId/onboarding',options,async request=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,request.params);return service.getDraft({userId:request.auth!.userId,restaurantId});
  });
  app.patch('/restaurants/:restaurantId/onboarding',options,async request=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,request.params);
    return service.saveDraft(actorFromAuth(request.auth!),restaurantId,validateWithSchema(draftPatchSchema,request.body));
  });
  app.post('/restaurants/:restaurantId/onboarding/finalize',options,async request=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,request.params),key=validateWithSchema(uuidSchema,request.headers['idempotency-key']);
    validateWithSchema(emptyBody,request.body);return service.finalizeDraft(actorFromAuth(request.auth!),restaurantId,key);
  });
  app.get('/restaurants/:restaurantId/activation',options,async request=>{
    const {restaurantId}=validateWithSchema(restaurantParamsSchema,request.params);return service.getActivation({userId:request.auth!.userId,restaurantId});
  });
  app.post('/restaurants/:restaurantId/activation/:module',options,async(request,reply)=>{
    const {restaurantId,module}=validateWithSchema(activationParams,request.params);validateWithSchema(emptyBody,request.body);
    await service.completeActivation({...actorFromAuth(request.auth!),restaurantId},module);return reply.status(204).send();
  });
}
