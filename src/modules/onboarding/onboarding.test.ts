import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerAuthDecorator} from '../../plugins/auth.js';
import {registerErrorHandler} from '../../plugins/error-handler.js';
import {registerOnboardingRoutes} from './routes.js';
import {createOnboardingService} from './service.js';
import type {OnboardingRepository} from './repository.js';
import {draftBasicsSchema,draftPatchSchema,guideModuleSchema} from './schemas.js';
test('drafts accept optional contact and dishes but never organization, owner, role, plan or completion authority',()=>{
  assert.deepEqual(draftBasicsSchema.parse({name:'Restaurante Teste',slug:'restaurante-teste'}),{name:'Restaurante Teste',slug:'restaurante-teste'});
  for(const extra of [{role:'owner'},{ownerId:'forged'},{organizationId:'forged'},{planType:'business'},{onboardingStatus:'complete'},{dishName:'required-dish'}]){
    assert.equal(draftBasicsSchema.safeParse({name:'Teste',slug:'teste',...extra}).success,false);
    assert.equal(draftPatchSchema.safeParse(extra).success,false);
  }
  assert.equal(draftPatchSchema.safeParse({}).success,false);
  assert.equal(draftPatchSchema.safeParse({onboardingStep:3}).success,false);
  assert.equal(draftBasicsSchema.safeParse({name:' ',slug:'invalid slug'}).success,false);
});
test('activation accepts only the existing independent guide modules',()=>{
  for(const name of ['cashier','menu','kitchen','settings','overview'])assert.equal(guideModuleSchema.parse(name),name);
  assert.equal(guideModuleSchema.safeParse('all').success,false);
});

test('onboarding HTTP takes its actor only from the verified session and requires an idempotency key',async()=>{
  const app=Fastify(),actor={userId:'10000000-0000-4000-8000-000000000001',sessionId:'40000000-0000-4000-8000-000000000001',sessionExpiresAt:4_000_000_000_000};
  registerErrorHandler(app);
  await registerAuthDecorator(app,async headers=>headers.cookie==='synthetic-session'?{...actor,email:'test@example.invalid',role:'authenticated'}:null);
  const calls:unknown[]=[];
  const repository={async createInitialDraft(input:unknown,key:string,body:unknown){calls.push({input,key,body});return {id:'draft-result'};}} as unknown as OnboardingRepository;
  await registerOnboardingRoutes(app,createOnboardingService(repository));
  try{
    const payload={name:'Primeiro',slug:'primeiro'},key='50000000-0000-4000-8000-000000000001';
    assert.equal((await app.inject({method:'POST',url:'/account/onboarding-draft',payload})).statusCode,401);
    const headers={cookie:'synthetic-session'};
    assert.equal((await app.inject({method:'POST',url:'/account/onboarding-draft',headers,payload})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/account/onboarding-draft',headers:{...headers,'idempotency-key':key},payload:{...payload,userId:actor.userId}})).statusCode,400);
    const result=await app.inject({method:'POST',url:'/account/onboarding-draft',headers:{...headers,'idempotency-key':key},payload});
    assert.equal(result.statusCode,201);assert.deepEqual(result.json(),{id:'draft-result'});
    assert.equal(result.headers['cache-control'],'no-store');
    assert.deepEqual(calls,[{input:actor,key,body:payload}]);
  }finally{await app.close();}
});
