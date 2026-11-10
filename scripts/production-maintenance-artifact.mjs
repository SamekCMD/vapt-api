// Offline artifact assembler only: no auth, provider APIs, CLI or apply path.
// A future authorized controller must pin source/deployment/configuration and
// verify that the API has no cron/queue handler triggers before using it.
const wrapper='__vapt_production_maintenance__.mjs';
const javascript=new Set(['application/javascript+module','text/javascript+module','application/javascript','text/javascript']);
const contentTypes=new Set([...javascript,'application/wasm','text/plain','application/octet-stream','application/source-map']);
const exactKeys=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const relativeName=value=>typeof value==='string'&&value.length<=200&&
 /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)&&
 value.split('/').every(part=>part!=='.'&&part!=='..');
export function createProductionMaintenanceArtifact(input) {
 try {
  if(!exactKeys(input,['entrypoint','modules'])||!relativeName(input.entrypoint)||
   !Array.isArray(input.modules)||input.modules.length<1||input.modules.length>16)throw Error();
  const names=new Set();let size=0;
  for(const file of input.modules) {
   if(!exactKeys(file,['name','type','bytes'])||!relativeName(file.name)||file.name===wrapper||
    names.has(file.name)||!contentTypes.has(file.type)||!Buffer.isBuffer(file.bytes)||file.bytes.length<1)throw Error();
   names.add(file.name);size+=file.bytes.length;
   if(size>8*1024*1024)throw Error();
  }
  const main=input.modules.find(file=>file.name===input.entrypoint);
  if(!main||!javascript.has(main.type))throw Error();
  const bytes=Buffer.from('export * from '+JSON.stringify('./'+input.entrypoint)+';\n'+
   'export default { fetch() { return Response.json({error:{code:"service_unavailable",message:"Service unavailable"}},'+
   '{status:503,headers:{"Cache-Control":"no-store","Retry-After":"60"}}); } };\n');
  if(size+bytes.length>8*1024*1024)throw Error();
  return {mainModule:wrapper,metadata:{main_module:wrapper},
   modules:[...input.modules.map(file=>({...file,bytes:Buffer.from(file.bytes)})),
    {name:wrapper,type:'application/javascript+module',bytes}]};
 } catch {throw Error('Invalid maintenance artifact input');}
}
