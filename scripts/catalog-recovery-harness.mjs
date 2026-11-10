// LOCAL TEST ONLY. No CLI, env discovery, remote database, provider key or deploy.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const ensure=value=>{if(!value)throw Error('Local catalog recovery guard failed');};
export async function createLocalCatalogRecoveryHarness({database,command:input,fault}={}){
  let url;try{url=new URL(database?.options?.connectionString);}catch{throw Error('Local catalog recovery database refused');}
  ensure(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.port&&url.username==='vapt_tenant_admin'&&/^[a-f0-9]{64}$/.test(url.password)
    &&url.pathname==='/vapt'&&/^-c vapt\.tenant_test_through=012$/.test(url.searchParams.get('options')??'')&&!url.hash);
  url.password='';url=undefined;ensure(['accepted','committed','projection','signal'].includes(fault));
  const directory=new URL('./catalog-recovery-runtime/',import.meta.url);
  for(const name of ['.env','.env.local','.dev.vars','.dev.vars.local'])ensure(!existsSync(fileURLToPath(new URL(name,directory))));
  const {validateCatalogCommand,fingerprintCommand}=await import('../src/modules/catalog-publication/policy.ts');
  const {applyCatalogCommand,findCommittedCommand}=await import('../src/modules/catalog-publication/transaction.ts');
  const {withRestaurantWrite}=await import('../src/modules/tenancy/authorization.ts');
  const command=validateCatalogCommand(structuredClone(input)),fingerprint=await fingerprintCommand(command);
  process.env.WRANGLER_SEND_METRICS='false';process.env.WRANGLER_WRITE_LOGS='false';process.env.NO_UPDATE_NOTIFIER='1';
  const {createTestHarness}=await import('wrangler');
  const nonce=randomBytes(32).toString('hex'),stats={sqlQueries:0,applyRequests:0,domainApplyCalls:0,finds:0,authorizations:0};
  let host,failed=false,requests=0,runtime,worker,closed=false;
  const db={query:async(...args)=>{stats.sqlQueries++;return database.query(...args);},connect:async()=>{
    const client=await database.connect();return{query:async(...args)=>{stats.sqlQueries++;return client.query(...args);},release:reason=>client.release(reason)};
  }};
  const bridge=createServer(async(req,res)=>{
    const send=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
    try{
      if(closed||req.headers.host!==host||req.method!=='POST'||req.headers['x-local-catalog-nonce']!==nonce||!['/apply','/find','/authorize'].includes(req.url)||requests++>=32)return send(403,{code:'local_bridge_refused'});
      let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)return send(413,{code:'local_body_limit'});body+=chunk;}
      const value=JSON.parse(body);body=undefined;
      ensure(value.operationId===command.operationId&&value.restaurantId===command.restaurantId&&value.actor?.userId===command.actor.userId);
      if(req.url==='/apply'){
        stats.applyRequests++;ensure(isDeepStrictEqual(value,command));
        if(fault==='accepted'&&!failed){failed=true;return send(503,{code:'local_interruption'});}
        stats.domainApplyCalls++;const committed=await applyCatalogCommand(db,value);
        if(fault==='committed'&&!failed){failed=true;res.destroy();return;}// Actual commit, lost HTTP acknowledgement.
        return send(200,committed);
      }
      if(req.url==='/find'){
        ensure(value.fingerprint===fingerprint);stats.finds++;return send(200,await findCommittedCommand(db,value));
      }
      stats.authorizations++;await withRestaurantWrite(db,{...value.actor,restaurantId:value.restaurantId},'restaurant.manage',async()=>{});
      send(200,{authorized:true});
    }catch(error){const status=[400,401,403,404,409,410,413].includes(error?.statusCode)?error.statusCode:503;send(status,{code:status===401?'unauthorized':'local_sql_stopped'});}
  });
  bridge.requestTimeout=10000;bridge.headersTimeout=10000;bridge.maxConnections=8;
  async function close(){if(closed)return;closed=true;try{await runtime?.close();}finally{bridge.closeAllConnections();await new Promise(ok=>bridge.close(ok));}}
  try{
    await new Promise((ok,fail)=>{bridge.once('error',fail);bridge.listen(0,'127.0.0.1',ok);});host='127.0.0.1:'+bridge.address().port;
    runtime=createTestHarness({workers:[{configPath:fileURLToPath(new URL('wrangler.jsonc',directory)),
      vars:{LOCAL_SQL_ORIGIN:'http://'+host,LOCAL_RESTAURANT:command.restaurantId,LOCAL_OPERATION:command.operationId,LOCAL_FAULT:fault,LOCAL_NOW:Date.now()+31536000000},
      secrets:{LOCAL_SQL_NONCE:nonce}}]});
    await runtime.listen();worker=runtime.getWorker('vapt-catalog-recovery-test');
    const access={operationId:command.operationId,restaurantId:command.restaurantId,actor:command.actor};
    const request=(path,body)=>{ensure(!closed);return worker.fetch('https://local-recovery.test/'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});};
    return{
      begin:()=>request('begin',command),status:()=>request('status',access),retry:()=>request('retry',access),readCatalog:()=>request('catalog'),
      async alarm(){const result=await request('alarm',{});ensure(result.status===200);return result.json();},
      async evict(){ensure(!closed);await worker.evictDurableObject('RECOVERY_COORDINATOR',{name:'recovery:'+command.restaurantId,webSockets:'hibernate'});},
      statistics:()=>({...stats}),close,
    };
  }catch{await close();throw Error('Local catalog recovery harness stopped');}
}
