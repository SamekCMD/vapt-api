import type {FastifyInstance} from 'fastify';
import {actorFromAuth,requireAuth} from '../../plugins/auth.js';
import {validateWithSchema} from '../../lib/validation.js';
import type {createAccountService} from './service.js';
import {bootstrapQuerySchema,selectionSchema,organizationParamsSchema} from './schemas.js';
export async function registerAccountRoutes(app:FastifyInstance,service:ReturnType<typeof createAccountService>){
  const options={config:{rateLimitGroup:'auth' as const},preHandler:async(request:Parameters<typeof requireAuth>[0],reply:Parameters<typeof requireAuth>[1])=>{
    reply.header('Cache-Control','no-store');await requireAuth(request,reply,app.authSessionResolver);
  }};
  app.get('/account/bootstrap',options,async request=>{
    const query=validateWithSchema(bootstrapQuerySchema,request.query);return service.getBootstrap(request.auth!.userId,query.restaurantId);
  });
  app.patch('/account/preference',options,async(request,reply)=>{
    await service.savePreference(actorFromAuth(request.auth!),validateWithSchema(selectionSchema,request.body));return reply.status(204).send();
  });
  app.get('/organizations/:organizationId/restaurant-entitlement',options,async request=>{
    const params=validateWithSchema(organizationParamsSchema,request.params);
    return service.getRestaurantEntitlement({userId:request.auth!.userId,organizationId:params.organizationId});
  });
}
