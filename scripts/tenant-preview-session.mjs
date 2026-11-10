// Operator-only lifecycle. Never serialize this object or supply secrets via env/CLI.
export function createTenantPreviewSession({accessJwt,bearer,expiresAt,now=Date.now,
  schedule=setTimeout,cancel=clearTimeout}={}){
  if(typeof accessJwt!=='string'||!accessJwt||typeof bearer!=='string'||!bearer
    ||!Number.isFinite(expiresAt)||expiresAt<=now())throw Error('Invalid temporary session');
  const controller=new AbortController(),deadline=Math.min(now()+1800000,expiresAt);
  let state='ready',rotated=false,timer;
  const close=()=>{state='closed';accessJwt=undefined;bearer=undefined;cancel(timer);controller.abort();};
  const check=()=>{if(now()>=deadline)close();if(state==='closed')throw Error('Temporary session closed');};
  timer=schedule(close,Math.max(0,deadline-now()));
  return{
    state:()=>state,retainsCredentials:()=>accessJwt!==undefined||bearer!==undefined,
    signal:controller.signal,deadline,close,
    async rotate(run){
      check();if(rotated||state!=='ready')throw Error('Renewal already attempted');
      rotated=true;
      const input={bearer,signal:controller.signal},erase=()=>{input.bearer=undefined;};
      controller.signal.addEventListener('abort',erase,{once:true});
      try{const result=await run(input);check();
        if(result?.status!==0)throw Error('Renewal unconfirmed');return result;
      }catch{close();throw Error('Temporary renewal stopped');}
      finally{erase();controller.signal.removeEventListener('abort',erase);}
    },
    async attempt(run,{resume=false}={}){
      check();if(!rotated||!(state==='ready'&&!resume||state==='paused'&&resume))throw Error('Explicit safe resume required');
      state='running';
      const input={accessJwt,bearer,signal:controller.signal},erase=()=>{input.accessJwt=undefined;input.bearer=undefined;};
      controller.signal.addEventListener('abort',erase,{once:true});
      try{
        const report=await run(input);
        if(state==='closed'||now()>=deadline||report?.ok||report?.cleaned!==true||report?.failureCode==='seed_uncertain')close();
        else state='paused';
        return report;
      }catch{close();throw Error('Temporary attempt stopped');}
      finally{erase();controller.signal.removeEventListener('abort',erase);}
    },
  };
}
