// Local test entry ONLY. Never imported/exported from the deployable API.
import {DurableObject} from 'cloudflare:workers';
import type {DurableObjectState,R2Bucket,DurableObjectNamespace} from '@cloudflare/workers-types';
import type {CatalogCommand} from '../../src/modules/catalog-publication/contracts.js';
import {SqliteCommandStore} from '../../src/worker/catalog/command-store.js';
import {createCatalogCoordinator,type OperationAccess} from '../../src/worker/catalog/runner.js';
import {createCatalogProjection} from '../../src/worker/catalog/projection.js';
import {AppError} from '../../src/lib/errors.js';
import {catalogRpcReply,unwrapCatalogRpc} from '../../src/worker/catalog/rpc.js';
type Env={LOCAL_SQL_ORIGIN:string;LOCAL_SQL_NONCE:string;LOCAL_RESTAURANT:string;LOCAL_OPERATION:string;LOCAL_FAULT:string;LOCAL_NOW:number;LOCAL_CATALOG:R2Bucket;RECOVERY_COORDINATOR:DurableObjectNamespace<LocalCatalogRecovery>};
export class LocalCatalogRecovery extends DurableObject<Env>{
  private readonly store:SqliteCommandStore;
  private readonly runner:ReturnType<typeof createCatalogCoordinator>;
  private readonly projection:ReturnType<typeof createCatalogProjection>;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);this.store=new SqliteCommandStore(ctx.storage.sql);
    ctx.storage.sql.exec('create table if not exists local_test_metrics(key text primary key,value integer not null)');
    if(this.value('clock')===0)this.set('clock',env.LOCAL_NOW);this.increment('constructors');
    const bucket=env.LOCAL_CATALOG;
    this.projection=createCatalogProjection({get:bucket.get.bind(bucket),list:bucket.list.bind(bucket),put:async(...args:Parameters<R2Bucket['put']>)=>{
      const value=await bucket.put(...args);this.increment('puts');if(this.value('puts')===2)this.fault('projection');return value;
    }},'preview');
    this.runner=createCatalogCoordinator({store:this.store,now:()=>this.value('clock'),
      authorize:access=>this.sql('authorize',access).then(()=>{}),
      storage:{transaction:work=>ctx.storage.transaction(async()=>work()),setAlarm:at=>ctx.storage.setAlarm(at),deleteAlarm:()=>ctx.storage.deleteAlarm(),sync:()=>ctx.storage.sync()},
      apply:async command=>{
        if(!this.store.intent(command.operationId)||await ctx.storage.getAlarm()===null)throw new Error('Missing durable intent/alarm');
        this.set('durable',1);return this.sql('apply',command);
      },findCommitted:identity=>this.sql('find',identity),project:committed=>this.projection.publish(committed),
      signal:async()=>{this.fault('signal');this.increment('signals');},prune:(id,cursor)=>this.projection.prune(id,cursor)});
  }
  private value(key:string){return Number(this.ctx.storage.sql.exec<{value:number}>('select value from local_test_metrics where key=?',key).toArray()[0]?.value??0);}
  private set(key:string,value:number){this.ctx.storage.sql.exec('insert into local_test_metrics values(?,?) on conflict(key) do update set value=excluded.value',key,value);}
  private increment(key:string){this.set(key,this.value(key)+1);}
  private fault(stage:string){if(this.env.LOCAL_FAULT===stage&&!this.value('failed')){this.set('failed',1);throw new Error('Local recovery interruption');}}
  private async sql(path:string,body:unknown):Promise<any>{
    if(!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(this.env.LOCAL_SQL_ORIGIN)||!/^[a-f0-9]{64}$/.test(this.env.LOCAL_SQL_NONCE))throw new Error('Local bridge refused');
    const response=await fetch(this.env.LOCAL_SQL_ORIGIN+'/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Catalog-Nonce':this.env.LOCAL_SQL_NONCE},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new AppError(response.status,'local_sql_stopped','Local SQL stopped');return response.json();
  }
  begin(command:CatalogCommand){return catalogRpcReply(async()=>{await this.runner.submit(command);return this.info();});}
  status(access:OperationAccess){return catalogRpcReply(async()=>{await this.runner.status(access);return this.info();});}
  retry(access:OperationAccess){return catalogRpcReply(async()=>{await this.runner.retry(access);return this.info();});}
  advance(){return catalogRpcReply(async()=>{this.incrementClock();await this.runner.alarm();return this.info();});}
  private incrementClock(){this.set('clock',this.value('clock')+6000);}
  catalog(){return catalogRpcReply(async()=>{const registration=await this.projection.readRegistration(this.env.LOCAL_RESTAURANT);return this.projection.readBySlug(registration.canonicalSlug);});}
  async info(){
    const value=this.store.get(this.env.LOCAL_OPERATION);if(!value)throw new Error('No operation');
    const {operationId,restaurantId,phase,committed,version,retryable}=value;
    return{receipt:{operationId,restaurantId,phase,committed,version,retryable},work:value.work,alarm:await this.ctx.storage.getAlarm(),constructors:this.value('constructors'),durableBeforeSql:this.value('durable')===1,
      privateChunks:this.ctx.storage.sql.exec("select operation_id from catalog_command_chunks where instr(payload,'synthetic-private')>0").toArray().length};
  }
  alarm(){return this.runner.alarm();}
}
export default{async fetch(request:Request,env:Env){
  const path=new URL(request.url).pathname;const room=env.RECOVERY_COORDINATOR.get(env.RECOVERY_COORDINATOR.idFromName('recovery:'+env.LOCAL_RESTAURANT));
  try{
    if(path==='/catalog'&&request.method==='GET')return Response.json(unwrapCatalogRpc(await room.catalog()),{headers:{'Cache-Control':'no-store'}});
    if(request.method!=='POST'||!['/begin','/status','/retry','/alarm'].includes(path))return new Response(null,{status:404});
    const value=await request.json() as any;
    if(path!=='/alarm'&&(value.restaurantId!==env.LOCAL_RESTAURANT||value.operationId!==env.LOCAL_OPERATION))return new Response(null,{status:403});
    const result=unwrapCatalogRpc(path==='/begin'?await room.begin(value):path==='/status'?await room.status(value):path==='/retry'?await room.retry(value):await room.advance());
    return Response.json(result,{status:path==='/begin'||path==='/retry'?(result.receipt.phase==='ready'?200:202):200});
  }catch(error){return Response.json({code:'local_test_stopped'},{status:error instanceof AppError?error.statusCode:503});}
}};
