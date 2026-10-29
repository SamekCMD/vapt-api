// One-use write-only loopback input for the specifically approved R2 test key.
// No provider calls, database access, file writes, logs or secret read endpoint.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
export async function createCatalogR2CredentialInput(){
  return createCredentialInput(false);
}
export async function createCatalogImageR2CredentialInput(){
  return createCredentialInput(true);
}
async function createCredentialInput(image){
  const tokenName=image?'vapt-catalog-production-image-test-2026-10-29':'vapt-catalog-production-writer-test-2026-10-27';
  const nonce=randomBytes(32).toString('hex');let origin,host,closed=false,received=false,claimed=false,resolve,reject;
  const pending=new Promise((ok,fail)=>{resolve=ok;reject=fail;});pending.catch(()=>{});
  const html=()=>`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="vapt-nonce" content="${nonce}"><title>Vapt — credencial R2 de teste</title>
<style nonce="${nonce}">body{font:18px system-ui;max-width:720px;margin:40px auto;padding:24px}label{display:block;margin:24px 0}input{display:block;width:100%;padding:12px;box-sizing:border-box}button{font:inherit;padding:14px}</style>
<h1>Credencial R2 para o teste de catálogo</h1><p>Use apenas a chave <strong>${tokenName}</strong>, limitada a objetos de <strong>vapt-catalog-production</strong>. Validade na Cloudflare:24h; uso local:até30min; revogação ao encerrar.</p>
<p>Copie os dois campos S3 da tela Cloudflare. Não cole API Token Value, senha, dados do banco ou cookies. Os valores serão entregues uma vez ao controlador local, somente em memória; não serão mostrados nesta página, no chat ou nos logs.</p>
<form id="keys" autocomplete="off"><label>Access Key ID<input id="access" type="password" autocomplete="off" spellcheck="false" required minlength="32" maxlength="32"></label><label>Secret Access Key<input id="secret" type="password" autocomplete="off" spellcheck="false" required minlength="64" maxlength="64"></label><button type="submit">Entregar chaves ao teste local</button></form><p id="state">Aguardando as duas chaves S3.</p>
<script nonce="${nonce}">const form=document.getElementById('keys'),a=document.getElementById('access'),s=document.getElementById('secret'),label=document.getElementById('state');let sent=false;
form.onsubmit=async event=>{event.preventDefault();if(sent)return;sent=true;form.querySelector('button').disabled=true;let body;
try{body=JSON.stringify({accessKeyId:a.value,secretAccessKey:s.value});a.value='';s.value='';const response=await fetch('/credentials',{method:'POST',headers:{'Content-Type':'application/json','X-Vapt-Nonce':document.querySelector('meta[name=vapt-nonce]').content},body});body=undefined;
if(response.status!==204)throw Error('local');form.hidden=true;label.textContent='Chaves recebidas pelo controlador. Aguarde o próximo passo no chat.';}
catch{body=undefined;a.value='';s.value='';label.textContent='Não foi possível confirmar a entrega. Avise no chat; não reenvie a chave.';}};</script></html>`;
  const server=createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':typeof value==='string'?'text/html; charset=utf-8':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`});res.end(value===undefined?'':typeof value==='string'?value:JSON.stringify(value));};
    try{
      if(closed||req.headers.host!==host||req.headers.origin!==undefined&&req.headers.origin!==origin)return send(403,{});
      if(req.method==='GET'&&req.url==='/')return send(200,html());
      if(req.headers['x-vapt-nonce']!==nonce)return send(403,{});
      if(req.method==='GET'&&req.url==='/status')return send(200,{state:received?'received':'waiting'});
      if(req.method!=='POST'||req.url!=='/credentials'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{});
      if(received||!claimed)return send(409,{});
      let body='',size=0;for await(const part of req){size+=part.length;if(size>4096)return send(400,{});body+=part;}
      let value;try{value=JSON.parse(body);}catch{return send(400,{});}body=undefined;
      if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).sort().join(',')!=='accessKeyId,secretAccessKey'
        ||typeof value.accessKeyId!=='string'||! /^[a-f0-9]{32}$/.test(value.accessKeyId)
        ||typeof value.secretAccessKey!=='string'||! /^[a-f0-9]{64}$/.test(value.secretAccessKey))return send(400,{});
      received=true;resolve({accessKeyId:value.accessKeyId,secretAccessKey:value.secretAccessKey,...(image?{receivedAt:Date.now()}:{})});value.accessKeyId=undefined;value.secretAccessKey=undefined;send(204);
    }catch{if(!res.headersSent)send(400,{});else res.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=4;
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});origin=`http://127.0.0.1:${server.address().port}`;host=new URL(origin).host;
  async function close(){if(closed)return;closed=true;clearTimeout(timer);reject(Error('Credential input closed'));await new Promise(ok=>{server.close(ok);server.closeAllConnections();});}
  const timer=setTimeout(()=>{void close();},1200000);timer.unref();
  return{url:origin,waitForCredentials(){if(claimed||closed)throw Error('Credential input already claimed');claimed=true;return pending;},close};
}
