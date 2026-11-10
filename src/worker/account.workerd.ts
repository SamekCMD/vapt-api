import assert from 'node:assert/strict';
import test from 'node:test';
import {createTestHarness} from 'wrangler';
test('Worker account bootstrap is capability-safe and onboarding keeps verified actor and explicit restaurant scope',async()=>{
  const server=createTestHarness({workers:[{configPath:'./wrangler.worker-test.jsonc'}]});
  try{
    await server.listen();const worker=server.getWorker('vapt-api-worker-test'),base='https://api.vapt.test';
    assert.equal((await worker.fetch(base+'/account/bootstrap')).status,401);
    const restaurantId='10000000-0000-4000-8000-000000000001',organizationId='30000000-0000-4000-8000-000000000001';
    const staff={cookie:'session=owner'},admin={cookie:'session=admin','content-type':'application/json','idempotency-key':'50000000-0000-4000-8000-000000000001'};
    const bootstrap=await worker.fetch(base+'/account/bootstrap',{headers:staff});assert.equal(bootstrap.status,200);
    assert.equal(bootstrap.headers.get('cache-control'),'no-store');
    const body=await bootstrap.json() as {organizations:{features:{cashier:boolean};capabilities:string[]}[]};
    assert.equal(body.organizations[0].features.cashier,true);
    assert.deepEqual(body.organizations[0].capabilities,['restaurant.read','restaurant.operate']);
    assert.doesNotMatch(JSON.stringify(body),/stripeCustomer|billingContact|planStatus|owner_email/);
    assert.equal((await worker.fetch(base+'/account/bootstrap?restaurantId=10000000-0000-4000-8000-000000000099',{headers:staff})).status,403);
    assert.equal((await worker.fetch(base+'/account/bootstrap?restaurantId=invalid',{headers:staff})).status,400);
    const create=(headers:Record<string,string>,payload:unknown)=>worker.fetch(`${base}/organizations/${organizationId}/restaurants/drafts`,{method:'POST',headers,body:JSON.stringify(payload)});
    assert.equal((await create({...admin,cookie:'session=owner'},{name:'Denied',slug:'denied'})).status,403);
    assert.equal((await create(admin,{name:'Draft',slug:'draft',role:'owner'})).status,400);
    assert.equal((await create(admin,{name:'Draft',slug:'draft'})).status,201);
    const finalize=await worker.fetch(`${base}/restaurants/${restaurantId}/onboarding/finalize`,{method:'POST',headers:admin,body:'{}'});
    assert.equal(finalize.status,200);assert.equal((await finalize.json() as {onboardingCompleted:boolean}).onboardingCompleted,true);
    assert.equal((await worker.fetch(`${base}/restaurants/${restaurantId}/activation/kitchen`,{method:'POST',headers:staff})).status,204);
    const activation=await worker.fetch(`${base}/restaurants/${restaurantId}/activation`,{headers:staff});
    assert.equal(activation.status,200);assert.equal((await activation.json() as {kitchen:boolean}).kitchen,true);
  }finally{await server.close();}
});
