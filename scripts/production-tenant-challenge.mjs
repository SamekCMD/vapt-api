// Operator-only loopback human challenge bridge. Never receives DB/API credentials.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
const cancelled=()=>Error('Human challenge cancelled');
const ensure=value=>{if(!value)throw Error('Human challenge guard failed');};

export async function createProductionTenantChallenge(){
  return createChallenge({roles:['owner','admin','manager','staff','owner'],title:'Validação de login e unidades',intro:'Serão cinco logins sintéticos.'});
}
export async function createProductionCatalogChallenge(){
  return createChallenge({roles:['owner'],title:'Validação do writer de catálogo',intro:'Será um login sintético de proprietário.'});
}
async function createChallenge({roles,title,intro}){
  const nonce=randomBytes(32).toString('hex');
  let state='waiting',step='waiting',pending=null,next=0,outcome,closed=false,startResolve,startReject;
  const start=new Promise((resolve,reject)=>{startResolve=resolve;startReject=reject;});start.catch(()=>{});
  const status=()=>({state,step,pending:pending?{index:pending.index,role:pending.role}:null,...(outcome?{outcome}: {})});
  let origin,host;
  const html=()=>`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="vapt-nonce" content="${nonce}"><title>Vapt — validação de produção</title>
<style nonce="${nonce}">body{font:18px system-ui;max-width:700px;margin:60px auto;padding:24px}button{padding:14px;font:inherit}#challenge{margin:24px 0}</style>
<h1>${title}</h1><p>${intro} Nenhum email ou pagamento será enviado. Mantenha esta aba aberta e conclua os desafios quando solicitados.</p><button id="start" disabled>Iniciar testes</button><p id="state">Aguardando início.</p><div id="challenge"></div>
<script nonce="${nonce}">
const nonce=document.querySelector('meta[name=vapt-nonce]').content,button=document.getElementById('start'),label=document.getElementById('state');
let widget,active=-1,ready=false,busy=false,done=false,starting=false;
async function request(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Vapt-Nonce':nonce,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!response.ok)throw Error('local');return response;}
button.onclick=async()=>{starting=true;button.disabled=true;try{await request('/start',{});}catch{label.textContent='Não foi possível iniciar. Avise no chat.';}};
window.vaptTurnstileReady=()=>{ready=true;};
async function tick(){try{const s=await(await request('/status')).json();
button.disabled=starting||s.state!=='waiting';
if(s.state==='finished'){done=true;button.disabled=true;if(widget!==undefined){turnstile.remove(widget);widget=undefined;}label.textContent=s.outcome.ok&&s.outcome.cleaned?'Validação concluída; dados sintéticos removidos.':'Validação encerrada. Consulte o resultado no chat.';return;}
label.textContent=s.pending?'Login '+(s.pending.index+1)+' de ${roles.length} ('+s.pending.role+'): conclua o desafio abaixo.':s.state==='waiting'?'Aguardando início.':'Testes em andamento; aguarde o próximo desafio.';
if(s.pending&&ready&&!busy&&s.pending.index!==active){if(widget!==undefined)turnstile.remove(widget);active=s.pending.index;const index=active;
widget=turnstile.render('#challenge',{sitekey:'0x4AAAAAAEhvIktjmb6yaq09',callback:async token=>{busy=true;try{await request('/challenge',{index,token});}catch{label.textContent='Desafio não recebido. Avise no chat.';}finally{token=undefined;busy=false;}},'expired-callback':()=>{active=-1;},'error-callback':()=>{label.textContent='O desafio não carregou. Avise no chat.';}});}
}catch{button.disabled=true;label.textContent='Controlador local encerrado. Consulte o chat.';done=true;}finally{if(!done)setTimeout(tick,2000);}}tick();
</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=vaptTurnstileReady&render=explicit" async defer></script></html>`;
  const server=createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':typeof value==='string'?'text/html; charset=utf-8':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'nonce-${nonce}'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`});res.end(value===undefined?'':typeof value==='string'?value:JSON.stringify(value));};
    try{
      if(closed||req.headers.host!==host||(req.headers.origin!==undefined&&req.headers.origin!==origin))return send(403,{});
      if(req.method==='GET'&&req.url==='/')return send(200,html());
      if(req.headers['x-vapt-nonce']!==nonce)return send(403,{});
      if(req.method==='GET'&&req.url==='/status')return send(200,status());
      if(req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{});
      if(!['/start','/challenge'].includes(req.url))return send(404,{});
      let body='',size=0;for await(const part of req){size+=part.length;if(size>12288){send(400,{});return;}body+=part;}
      let value;try{value=JSON.parse(body);}catch{return send(400,{});}body=undefined;
      if(!value||typeof value!=='object'||Array.isArray(value))return send(400,{});
      if(req.url==='/start'){
        if(Object.keys(value).length)return send(400,{});
        if(state!=='waiting')return send(409,{});
        state='running';step='starting';startResolve();return send(200,{});
      }
      if(state!=='running'||!pending)return send(409,{});
      if(Object.keys(value).length!==2||value.index!==pending.index||typeof value.token!=='string'||value.token.length<20||value.token.length>8192||/[\r\n]/.test(value.token)||value.token.startsWith('XXXX.DUMMY.'))return send(400,{});
      const current=pending;pending=null;next++;current.detach();current.resolve(value.token);value.token=undefined;send(204);
    }catch{if(!res.headersSent)send(400,{});else res.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=8;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;host=new URL(origin).host;
  async function close(){
    if(closed)return;closed=true;clearTimeout(timer);startReject(cancelled());
    if(pending){const current=pending;pending=null;current.detach();current.reject(cancelled());}
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
  const timer=setTimeout(()=>{void close();},20*60*1000);timer.unref();
  return{
    url:origin,waitForStart:()=>start,
    async captcha({index,role,signal}={}){
      ensure(!closed&&state==='running'&&!pending&&next<roles.length&&index===next&&role===roles[index]);signal?.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const abort=()=>{if(pending?.index===index)pending=null;signal?.removeEventListener('abort',abort);reject(cancelled());};
        pending={index,role,resolve,reject,detach:()=>signal?.removeEventListener('abort',abort)};signal?.addEventListener('abort',abort,{once:true});
      });
    },
    progress(value){ensure(typeof value==='string'&&/^[a-z0-9_]{1,48}$/.test(value));step=value;},
    complete(result){
      ensure(!closed&&!pending&&state==='running');state='finished';step=result.ok&&result.cleaned?'verified':'stopped';
      outcome={ok:result.ok===true,cleaned:result.cleaned===true,checks:Number.isInteger(result.checks)?result.checks:0};
    },close,
  };
}
