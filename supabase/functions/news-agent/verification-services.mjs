import {runVerificationInvocation} from './verification-runtime.mjs';
import {createPublicEvidenceTransport} from './public-evidence-transport.mjs';
const operations={
 warpcore_verification_claim:[],warpcore_curator_snapshot:['p_story'],warpcore_agent_history:['p_cursor'],
 warpcore_verification_reserve:['p_job','p_lease','p_hash','p_max','p_metadata'],warpcore_verification_dispatch:['p_job','p_lease'],
 warpcore_verification_settle:['p_job','p_lease','p_status','p_cost','p_audit'],warpcore_verification_finish:['p_job','p_lease','p_status','p_receipt'],
 warpcore_agent_issue_receipt:['p_material'],warpcore_verification_handoff:['p_job','p_lease'],
};
export function createVerificationService(config={},dependencies={}){
 const project=new URL(config.projectUrl),key=config.serviceKey;
 if(project.protocol!=='https:'||!project.hostname.endsWith('.supabase.co')||project.username||project.password||project.port||project.pathname!=='/'||project.search||project.hash||typeof key!=='string'||!key||/[\r\n]/.test(key))throw Error('Invalid verification database configuration');
 const {rpcFetcher=fetch,modelFetcher=fetch,evidenceFetcher=createPublicEvidenceTransport({runtime:dependencies.runtime??globalThis.Deno}),now}=dependencies;
 if([rpcFetcher,modelFetcher,evidenceFetcher].some(f=>typeof f!=='function'))throw Error('Invalid verification transport');
 const runtimeConfig=structuredClone(config.runtimeConfig??{});
 const rpc=async(name,body)=>{
  const keys=operations[name];
  if(!keys||!body||Array.isArray(body)||Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k)))throw Error('Unsupported verification operation');
  const controller=new AbortController();let timer;
  const operation=(async()=>{
   const response=await rpcFetcher(new URL('/rest/v1/rpc/'+name,project),{method:'POST',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!(response instanceof Response)||!response.ok||response.redirected||!response.body){if(response instanceof Response&&response.body)void response.body.cancel().catch(()=>{});throw Error();}
   const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>2500000)){void response.body.cancel().catch(()=>{});throw Error();}
   const reader=response.body.getReader(),chunks=[];let size=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{
    for(;;){const {value,done}=await reader.read();if(controller.signal.aborted)throw Error();if(done)break;size+=value.byteLength;if(size>2500000)throw Error();chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   }finally{controller.signal.removeEventListener('abort',cancel);cancel();}
  })();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},10000);});
  try{return await Promise.race([operation,deadline]);}catch{throw Error('Verification database operation unconfirmed');}finally{clearTimeout(timer);controller.abort();}
 };
 return {runInvocation:()=>runVerificationInvocation({config:runtimeConfig,rpc,modelFetcher,evidenceFetcher,...(now?{now}:{})})};
}
