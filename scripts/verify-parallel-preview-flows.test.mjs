import assert from 'node:assert/strict';
import test from 'node:test';
import { runPreviewFlows } from './verify-parallel-preview-flows.mjs';

const baseUrl='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const publicBase='https://pub-c7718cfb495f4c83866dfe3ed8c52890.r2.dev';
const r2Host='https://3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com';
const userId='11111111-1111-4111-8111-111111111111';
const restaurantId='22222222-2222-4222-8222-222222222222';
const itemId='33333333-3333-4333-8333-333333333333';
const orderId='44444444-4444-4444-8444-444444444444';
const objectKey=`${restaurantId}/${itemId}`;
function fixture({failPath,negativeAccepted=false,wrongSigner=false,virtualHosted=false}={}){
  const signer=virtualHosted?'https://vapt-assets-preview.3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com':r2Host;
  const signedPath=virtualHosted?`/${objectKey}`:`/vapt-assets-preview/${objectKey}`;
  const calls=[];let loggedIn=false,revoked=false,createdOrder=false,object=false,now=1000;
  const cleanupCalls=[];
  const fetcher=async(url,options={})=>{
    calls.push({url,options});
    const u=new URL(url),path=u.pathname,body=typeof options.body==='string'?JSON.parse(options.body):options.body;
    if(path===failPath)throw new Error('private database credential');
    if(u.origin===signer){
      const mismatch=path!==signedPath||options.headers['Content-Type']!=='image/png'||Number(options.headers['Content-Length'])!==68||now>61000;
      if(mismatch&&!negativeAccepted)return new Response('',{status:403});
      object=true;return new Response('',{status:200});
    }
    if(u.origin===publicBase)return new Response(object?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=','base64'):null,{status:object?200:404,headers:{'content-type':'image/png','content-length':'68'}});
    assert.equal(u.origin,baseUrl);
    assert.equal(options.headers.Origin,'https://infra-foundation-vapt-web.autoistloko.workers.dev');
    if(path==='/api/auth/sign-up/email'){assert.equal(body.email,'delivered@resend.dev');return Response.json({user:{id:userId,email:body.email}});}
    if(path==='/api/auth/verify-email')return Response.json({status:true});
    if(path==='/api/auth/sign-in/email'){loggedIn=true;return Response.json({user:{id:userId}},{headers:{'set-cookie':'__Secure-better-auth.session_token=private-cookie; Path=/; Secure; HttpOnly'}});}
    if(path==='/auth/me')return loggedIn&&!revoked?Response.json({userId,email:'delivered@resend.dev'}):Response.json({error:{code:'unauthorized'}},{status:401});
    if(path==='/onboarding')return Response.json({id:restaurantId,name:body.restaurantName,slug:body.slug},{status:201});
    if(path==='/restaurants/me')return Response.json({id:restaurantId,name:'updated',slug:'stage11-test-abc123'});
    if(path==='/restaurants/me/menu-items'&&options.method==='POST')return Response.json({id:itemId,...body},{status:201});
    if(path==='/restaurants/me/menu-items')return Response.json([{id:itemId}]);
    if(path.includes('/menu-items/')&&path.endsWith('/image/upload'))return Response.json({method:'PUT',objectKey,uploadUrl:(wrongSigner?'https://production.example':signer)+signedPath+'?X-Amz-Signature=private-signature',publicUrl:publicBase+'/'+objectKey,headers:{'Content-Type':'image/png'},expiresInSeconds:60});
    if(path.endsWith('/image')&&options.method==='DELETE'){object=false;return new Response(null,{status:204});}
    if(path.startsWith('/restaurants/me/menu-items/'))return options.method==='DELETE'?new Response(null,{status:204}):Response.json({id:itemId,price:'13.00'});
    if(path==='/public/orders'&&options.method==='POST'){
      const replay=createdOrder;createdOrder=true;
      return Response.json({orderId,restaurantId,publicToken:'private-order-token',idempotentReplay:replay},{status:replay?200:201});
    }
    if(path===`/public/orders/${orderId}`)return Response.json({id:orderId});
    if(path==='/restaurants/me/kitchen/orders')return Response.json([{id:orderId}]);
    if(path===`/restaurants/me/kitchen/orders/${orderId}/status`)return Response.json({id:orderId,status:body.status});
    if(path.startsWith('/auth/restaurants/'))return Response.json({error:{code:'forbidden'}},{status:403});
    if(path==='/api/auth/sign-out'){revoked=true;return Response.json({success:true});}
    throw new Error('Unhandled fixture route: '+path);
  };
  const cleanup=async(tag,ids)=>{cleanupCalls.push({tag,ids});object=false;return {rows:0,objects:0,outbox:0};};
  return {options:{baseUrl,accessHeaders:{'Cf-Access-Token':'private-access-token'},bearer:'private-preview-bearer-value',tag:'stage11-test-abc123',fetcher,cleanup,
    verificationUrl:async()=>baseUrl+'/api/auth/verify-email?token=private-verification-token',
    now:()=>now,waitForExpiry:async ms=>{now+=ms;}},calls,cleanupCalls};
}

test('proves auth persistence/revocation, API writes, order idempotency and bounded R2 upload/delete',async()=>{
  const f=fixture();const result=await runPreviewFlows(f.options);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.cleaned,true);
  assert.equal(result.checks.auth,true);assert.equal(result.checks.orders,true);assert.equal(result.checks.storage,true);
  assert.equal(f.cleanupCalls.length,1);assert.equal(f.cleanupCalls[0].ids.restaurantId,restaurantId);
  const orders=f.calls.filter(x=>new URL(x.url).pathname==='/public/orders');
  assert.equal(orders.length,2);assert.equal(new Set(orders.map(x=>x.options.headers['Idempotency-Key'])).size,1);
  const r2=f.calls.filter(x=>x.url.startsWith(r2Host));assert.equal(r2.length,5);
  for(const call of r2){assert.equal(new Headers(call.options.headers).has('authorization'),false);assert.equal(new Headers(call.options.headers).has('cf-access-token'),false);}
  for(const secret of ['private-access-token','private-preview-bearer-value','private-cookie','private-signature','private-verification-token','private-order-token'])assert.equal(JSON.stringify(result).includes(secret),false);
});

test('always cleans tagged fixtures on API failure without returning raw errors',async()=>{
  const f=fixture({failPath:'/restaurants/me'});const result=await runPreviewFlows(f.options);
  assert.equal(result.ok,false);assert.equal(result.cleaned,true);assert.equal(f.cleanupCalls.length,1);
  assert.equal(JSON.stringify(result).includes('private database credential'),false);
});

test('accepts only the exact preview bucket when the SDK uses virtual-hosted S3 addressing',async()=>{
  const f=fixture({virtualHosted:true});const result=await runPreviewFlows(f.options);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.cleaned,true);
});

test('detects an accepted invalid R2 signature and invokes object cleanup',async()=>{
  const f=fixture({negativeAccepted:true});const result=await runPreviewFlows(f.options);
  assert.equal(result.ok,false);assert.equal(result.failure,'storage_constraints');assert.equal(f.cleanupCalls.length,1);
  assert.ok(f.cleanupCalls[0].ids.objectKeys.includes(objectKey+'-tampered'));
});

test('does not send credentials or data to unapproved hosts and requires cleanup before mutation',async()=>{
  for(const patch of [{baseUrl:'https://api.vapt.app.br'},{cleanup:undefined},{tag:'other-tag'},{accessHeaders:{Cookie:'private-cookie'}}]){
    const f=fixture();await assert.rejects(runPreviewFlows({...f.options,...patch}),/Invalid Preview flow input/);assert.equal(f.calls.length,0);
  }
  const f=fixture({wrongSigner:true});const result=await runPreviewFlows(f.options);
  assert.equal(result.ok,false);assert.equal(f.calls.some(x=>x.url.startsWith('https://production.example')),false);assert.equal(f.cleanupCalls.length,1);
});

test('does not claim cleanup when independently checked residue is nonzero',async()=>{
  const f=fixture();const result=await runPreviewFlows({...f.options,cleanup:async()=>({rows:1,objects:0,outbox:0})});
  assert.equal(result.ok,false);assert.equal(result.cleaned,false);assert.equal(result.failure,'cleanup');
});

test('waits for every concurrent order request before cleaning after one request fails',async()=>{
  const f=fixture();let orders=0,settled=false,cleanupAfterSettlement=false;
  const result=await runPreviewFlows({...f.options,fetcher:async(url,options)=>{
    if(new URL(url).pathname==='/public/orders'){
      if(++orders===1)throw new Error('simulated failure');
      await new Promise(resolve=>setTimeout(resolve,20));
      const response=await f.options.fetcher(url,options);settled=true;return response;
    }
    return f.options.fetcher(url,options);
  },cleanup:async(tag,ids)=>{cleanupAfterSettlement=settled;return f.options.cleanup(tag,ids);}});
  assert.equal(result.ok,false);assert.equal(cleanupAfterSettlement,true);
});
