// Operator-only ordering/freshness guard. Normal sign-in must still validate
// the real Turnstile response server-side. No credential discovery or writes.
const ensure=value=>{if(!value)throw Error('Pre-issuance challenge stopped');};
export async function prepareCatalogChallengeBeforeIssuance(options={}){
  ensure(['captcha','confirmIssuance','recordChallenge','openInput','receiveCredentials','confirmRun'].every(n=>typeof options[n]==='function')&&options.signal?.throwIfAborted);
  const now=options.now??(()=>performance.now()),expiry=new AbortController();
  const signal=AbortSignal.any([options.signal,expiry.signal]);
  let token,receivedAt,timer,collector,closed=false,taken=false,loginAuthorized=false;
  const close=()=>{closed=true;token=undefined;clearTimeout(timer);signal.removeEventListener('abort',discard);};
  const discard=()=>{token=undefined;};signal.addEventListener('abort',discard,{once:true});
  const age=()=>{const current=now();ensure(Number.isFinite(receivedAt)&&Number.isFinite(current)&&current>=receivedAt);return current-receivedAt;};
  const fresh=()=>{signal.throwIfAborted();ensure(!closed&&!taken&&typeof token==='string'&&age()<120000);};
  async function wait(work){
    signal.throwIfAborted();let cancel;
    const stopped=new Promise((_,reject)=>{cancel=()=>reject(Error('Pre-issuance challenge stopped'));signal.addEventListener('abort',cancel,{once:true});});
    try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return work(signal);}),stopped]);}
    finally{signal.removeEventListener('abort',cancel);}
  }
  try{
    token=await wait(active=>options.captcha({index:0,role:'owner',signal:active}));receivedAt=now();
    ensure(typeof token==='string'&&token.length>=20&&token.length<=2048&&!/[\r\n]/.test(token)&&!token.startsWith('XXXX.DUMMY.'));
    fresh();timer=setTimeout(()=>{discard();expiry.abort();},120000);timer.unref();
    await wait(active=>options.confirmIssuance({remainingMs:120000-age(),signal:active}));fresh();
    await wait(()=>options.recordChallenge());fresh();
    // Drain listener/journal setup: never orphan a late-created collector.
    collector=await options.openInput({signal});fresh();ensure(typeof collector?.close==='function');
    await wait(active=>options.receiveCredentials({collector,signal:active}));fresh();
    const input=collector;collector=undefined;await input.close();fresh();
    await wait(active=>options.confirmRun({remainingMs:120000-age(),signal:active}));fresh();
    return{
      async captcha({index,role,signal:gateSignal}={}){
        gateSignal?.throwIfAborted();fresh();ensure(index===0&&role==='owner');
        taken=true;clearTimeout(timer);const value=token;token=undefined;return value;
      },
      authorizeLogin(){
        options.signal.throwIfAborted();ensure(!closed&&taken&&!loginAuthorized&&age()<180000);
        loginAuthorized=true;
      },
      close,
    };
  }catch{close();throw Error('Pre-issuance challenge stopped');}
  finally{if(collector)await collector.close();}
}
