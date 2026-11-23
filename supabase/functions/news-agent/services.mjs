import {runPagedShadowInvocation} from './paged-runtime.mjs';
import {createCandidateSource} from './candidate-source.mjs';
const operations={paged_link_history:['p_run','p_lease','p_revision'],paged_link_reserve:['p_run','p_lease','p_revision','p_hash','p_max','p_history'],paged_link_commit:['p_run','p_lease','p_revision','p_decisions','p_history','p_relays'],release:['p_run','p_lease'],claim:['p_run','p_seconds'],load:['p_run'],paged_append:['p_run','p_lease','p_revision','p_page'],paged_preview:['p_run','p_lease','p_revision','p_size'],paged_begin:['p_run','p_lease','p_revision','p_size'],paged_commit:['p_run','p_lease','p_revision','p_decisions'],paged_uncertain:['p_run','p_lease','p_revision'],paged_bind_config:['p_run','p_lease','p_config'],paged_reserve:['p_run','p_lease','p_revision','p_hash','p_max'],dispatch:['p_attempt','p_lease'],paged_settle:['p_attempt','p_lease','p_status','p_cost','p_audit']};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
// Fixed-origin RPC transport only; SQL text is matched locally, never sent remotely.
// Administrative setup and producer activation are separate from this adapter.
export function createAgentService(config={},fetcher=fetch){
 const project=new URL(config.projectUrl);
 if(project.protocol!=='https:'||!project.hostname.endsWith('.supabase.co')||project.username||project.password||project.port||project.pathname!=='/'||project.search||project.hash||typeof config.serviceKey!=='string'||!config.serviceKey||/[\r\n]/.test(config.serviceKey)||typeof fetcher!=='function')throw Error('Invalid agent database configuration');
 const runtime=structuredClone(config.runtimeConfig??{}),invocationOptions=structuredClone(config.invocationOptions??{}),key=config.serviceKey;
 const rpc=async(name,body)=>{
  const controller=new AbortController();let timer;
  const operation=(async()=>{
   const response=await fetcher(new URL('/rest/v1/rpc/warpcore_shadow_'+name,project),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!(response instanceof Response)||!response.ok||response.redirected||!response.body){if(response instanceof Response&&response.body)void response.body.cancel().catch(()=>{});throw Error();}
   const reader=response.body.getReader();const chunks=[];let length=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{
    for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>2000000)throw Error();chunks.push(value);}
    const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
   }finally{controller.signal.removeEventListener('abort',cancel);cancel();}
  })();
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},10000);});
  try{return await Promise.race([operation,timeout]);}catch{throw Error('Shadow database operation unconfirmed');}finally{clearTimeout(timer);controller.abort();}
 };
 const query=async(sql,args)=>{
  const match=/^select shadow_agent\.([a-z_]+)\(([^)]*)\) as value$/.exec(sql);
  const names=match&&operations[match[1]];
  if(!names||args.length!==names.length||match[2]!==names.map((_,i)=>`$${i+1}`).join(','))throw Error('Unsupported shadow query');
  return {rows:[{value:await rpc(match[1],Object.fromEntries(names.map((name,i)=>[name,args[i]])))}]};
 };
 const fetchPage=createCandidateSource({query:async(_sql,[p_started,p_cursor])=>({rows:await rpc('candidate_page',{p_started,p_cursor})})});
 return {
  selectRun:async()=>{if(runtime.enabled!==true)return null;const run=await rpc('select_run',{});if(run!==null&&(typeof run!=='string'||!uuid.test(run)))throw Error('Invalid selected run');return run;},
  runInvocation:runId=>runPagedShadowInvocation({runId,config:runtime,query,fetcher,fetchPage},invocationOptions),
 };
}
