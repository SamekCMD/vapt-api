// Operator-only in-memory transport for the existing bootstrap client.
// No CLI, credential discovery, refresh, provisioning or flag changes.
const api='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const origin='https://infra-foundation-vapt-web.autoistloko.workers.dev';
const audience='cc34f236f1f65ad868f3e086ab561ca053517b18691898db418096fc8e7080d5';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ensure=value=>{if(!value)throw Error('private_bootstrap_transport_stopped');};
export function createPrivateBootstrapTransport(input,ports={}) {
  try {
    ensure(input&&Object.keys(input).sort().join(',')==='accessJwt,bearer,operationId,restaurantId');
    ensure(uuid.test(input.restaurantId)&&uuid.test(input.operationId));
    ensure(typeof input.bearer==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(input.bearer));
    ensure(typeof input.accessJwt==='string'&&input.accessJwt.length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.accessJwt));
    const claims=JSON.parse(Buffer.from(input.accessJwt.split('.')[1],'base64url').toString('utf8'));
    const now=Date.now()/1000;
    ensure(Array.isArray(claims.aud)&&claims.aud.length===1&&claims.aud[0]===audience);
    ensure(Number.isSafeInteger(claims.exp)&&claims.exp>now+60&&claims.exp<now+3660);
  } catch { throw Error('private_bootstrap_transport_stopped'); }
  const get=api+'/restaurants/'+input.restaurantId,post=get+'/catalog/rebuild',operationId=input.operationId;
  let accessJwt=input.accessJwt,bearer=input.bearer,session,phase=0;
  const network=ports.fetch??fetch,abort=new AbortController();
  function clear(){accessJwt=undefined;bearer=undefined;session=undefined;phase=2;}
  function dispose(){clear();abort.abort();}
  return {
    dispose,
    async request(url,init) {
      try {
        ensure(phase<2&&accessJwt&&bearer&&typeof url==='string'&&init&&typeof init==='object');
        ensure(Object.keys(init).every(key=>['method','redirect','credentials','cache','signal','headers','body'].includes(key)));
        ensure(init.redirect==='error'&&init.credentials==='omit'&&init.cache==='no-store'&&init.signal instanceof AbortSignal);
        const isGet=phase===0;
        ensure(url===(isGet?get:post)&&init.method===(isGet?'GET':'POST'));
        const headers=new Headers(init.headers),keys=[...headers.keys()].sort().join(',');
        ensure(keys===(isGet?'cookie,origin':'content-type,cookie,idempotency-key,origin,x-vapt-catalog-protocol'));
        const cookie=headers.get('cookie');ensure(cookie&&cookie.length<=4096&&/^[\x20-\x7e]+$/.test(cookie)&&headers.get('origin')===origin);
        if(isGet){ensure(init.body===undefined);session=cookie;}
        else ensure(cookie===session&&init.body==='{}'&&headers.get('content-type')==='application/json'
          &&headers.get('x-vapt-catalog-protocol')==='1'&&headers.get('idempotency-key')===operationId);
        headers.set('CF-Access-Token',accessJwt);headers.set('Authorization','Bearer '+bearer);
        phase++;
        const response=await network(url,{method:init.method,headers,redirect:'error',credentials:'omit',cache:'no-store',
          signal:AbortSignal.any([init.signal,abort.signal]),...(isGet?{}:{body:'{}'})});
        // Do not abort the returned response body before the bootstrap validates
        // it. The caller disposes in finally; no references remain after POST.
        if(!isGet||response.status!==200)clear();
        return response;
      } catch {dispose();throw Error('private_bootstrap_transport_stopped');}
    },
  };
}
