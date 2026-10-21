import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerAuthDecorator} from '../../plugins/auth.js';
import {registerErrorHandler} from '../../plugins/error-handler.js';
import {registerAccountRoutes} from './routes.js';
import {createAccountService} from './service.js';
import type {AccountRepository} from './repository.js';
const userId='10000000-0000-4000-8000-000000000001',organizationId='20000000-0000-4000-8000-000000000001';
const a='30000000-0000-4000-8000-000000000001',b='30000000-0000-4000-8000-000000000002';
function fixture(){
  const data={organizations:[{id:organizationId,name:'Grupo Teste',role:'staff' as const,planType:'business' as const,
    planStatus:'active' as const,trialEndsAt:null,stripeCustomerId:'cus_private',billingContactEmail:'private@example.invalid'}],
    restaurants:[{id:a,organizationId,name:'A',slug:'a-test',onboardingStatus:'complete' as 'complete'|'draft'}],
    preference:null as {organizationId:string;restaurantId:string}|null};
  const repository={async loadAccount(id:string){assert.equal(id,userId);return data;},
    async savePreference(){throw new Error('bootstrap must not write');}} as unknown as AccountRepository;
  return {data,service:createAccountService(repository)};
}
test('staff bootstrap supplies operation features without private billing fields',async()=>{
  const {service}=fixture();const bootstrap=await service.getBootstrap(userId);
  assert.equal(bootstrap.organizations[0].features.cashier,true);
  assert.deepEqual(Object.keys(bootstrap.organizations[0]).sort(),['capabilities','features','id','name','role']);
  assert.deepEqual(bootstrap.organizations[0].capabilities,['restaurant.read','restaurant.operate']);
  assert.equal(bootstrap.currentRestaurantId,a);assert.equal(bootstrap.destination,'dashboard');
  assert.doesNotMatch(JSON.stringify(bootstrap),/cus_private|private@example|billingContact|planStatus|trialEndsAt/);
});
test('bootstrap selects only a unique restaurant, explicit route or accessible preference',async()=>{
  const f=fixture();f.data.restaurants.push({...f.data.restaurants[0],id:b,name:'B',slug:'b-test'});
  assert.equal((await f.service.getBootstrap(userId)).destination,'select-restaurant');
  assert.equal((await f.service.getBootstrap(userId)).currentRestaurantId,null);
  f.data.preference={organizationId,restaurantId:b};
  assert.equal((await f.service.getBootstrap(userId)).currentRestaurantId,b);
  assert.equal((await f.service.getBootstrap(userId,a)).currentRestaurantId,a);
  f.data.preference={organizationId,restaurantId:'30000000-0000-4000-8000-000000000099'};
  assert.equal((await f.service.getBootstrap(userId)).currentRestaurantId,null);
  await assert.rejects(f.service.getBootstrap(userId,'invalid'),{statusCode:400});
  await assert.rejects(f.service.getBootstrap(userId,'30000000-0000-4000-8000-000000000099'),{statusCode:403});
});
test('zero restaurants and selected drafts resume onboarding without an implicit preference write',async()=>{
  const f=fixture();f.data.restaurants[0].onboardingStatus='draft';
  assert.equal((await f.service.getBootstrap(userId)).destination,'onboarding');
  f.data.restaurants=[];f.data.organizations=[];
  const empty=await f.service.getBootstrap(userId);
  assert.equal(empty.destination,'onboarding');assert.equal(empty.currentRestaurantId,null);assert.equal(empty.currentOrganizationId,null);
});

test('account HTTP exposes only authenticated safe bootstrap and validates explicit preference input',async()=>{
  const app=Fastify(),f=fixture(),actor={userId,sessionId:'40000000-0000-4000-8000-000000000001',sessionExpiresAt:4_000_000_000_000};
  registerErrorHandler(app);
  await registerAuthDecorator(app,async headers=>headers.cookie==='synthetic-session'?{...actor,email:'test@example.invalid',role:'authenticated'}:null);
  let saved:unknown;
  f.service.savePreference=async(input,selection)=>{saved={input,selection};};
  await registerAccountRoutes(app,f.service);
  try{
    assert.equal((await app.inject({url:'/account/bootstrap'})).statusCode,401);
    const headers={cookie:'synthetic-session'};
    const bootstrap=await app.inject({url:'/account/bootstrap',headers});assert.equal(bootstrap.statusCode,200);
    assert.equal(bootstrap.headers['cache-control'],'no-store');
    assert.equal((await app.inject({url:'/account/bootstrap?restaurantId=not-a-uuid',headers})).statusCode,400);
    assert.equal((await app.inject({url:'/account/bootstrap?restaurantId=30000000-0000-4000-8000-000000000099',headers})).statusCode,403);
    assert.equal((await app.inject({method:'PATCH',url:'/account/preference',headers,payload:{organizationId,restaurantId:a,role:'owner'}})).statusCode,400);
    assert.equal((await app.inject({method:'PATCH',url:'/account/preference',headers,payload:{organizationId,restaurantId:a}})).statusCode,204);
    assert.deepEqual(saved,{input:actor,selection:{organizationId,restaurantId:a}});
  }finally{await app.close();}
});
