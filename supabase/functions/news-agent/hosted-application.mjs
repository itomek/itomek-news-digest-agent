import {handleAgent} from './handler.mjs';
import {createAgentService} from './services.mjs';
const flags={publishing_enabled:false};
function bootstrapTransport({projectUrl,serviceKey},fetcher){
 const project=new URL(projectUrl);
 if(project.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(project.hostname)||project.href!==project.origin+'/'||typeof serviceKey!=='string'||!serviceKey||/[\r\n]/.test(serviceKey))throw Error('Invalid hosted configuration');
 return async name=>{
  if(!['warpcore_agent_authorization','warpcore_agent_runtime_config'].includes(name))throw Error('Invalid bootstrap operation');
  const controller=new AbortController();let timer;
  const operation=(async()=>{
   const response=await fetcher(new URL('/rest/v1/rpc/'+name,project),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:'{}'});
   if(!(response instanceof Response)||!response.ok||response.redirected||!response.body)throw Error();
   const reader=response.body.getReader();let size=0;const chunks=[];
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32000)throw Error();chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   }finally{controller.signal.removeEventListener('abort',cancel);cancel();}
  })();
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},10000);})]);}
  catch{throw Error('Hosted bootstrap unavailable');}finally{clearTimeout(timer);controller.abort();}
 };
}
// Private server bootstrap occurs after platform JWT verification. The dedicated
// producer token gates runtime secret lookup and all discovery/verification work.
// No config, source URL, model or credential is accepted from the trigger body.
export function createHostedApplication(config,dependencies={}){
 const rpc=dependencies.bootstrapRpc??bootstrapTransport(config,dependencies.fetcher??fetch);
 const discoveryFactory=dependencies.createDiscoveryService??createAgentService;
 const verifierFactory=dependencies.createVerifierService;
 return async req=>{
  if(req.method!=='POST')return new Response('POST required',{status:405});
  try{
   const authorization=await rpc('warpcore_agent_authorization');
   if(authorization?.enabled===false)return Response.json({mode:'disabled',...flags});
   if(authorization?.enabled!==true||typeof authorization.producerToken!=='string')throw Error();
   let settings,discovery,verifier;
   const getSettings=()=>settings??=(async()=>{
    const value=await rpc('warpcore_agent_runtime_config');
    if(value?.model!=='openai/gpt-oss-120b'||typeof value.apiKey!=='string'||!value.apiKey||value.maxOutputTokens!==4096||value.maxCostCredits!==0.058983||!Array.isArray(value.allowedSourceHosts)||!value.allowedSourceHosts.length)throw Error();
    return {...value,enabled:true,requireModelProfile:true,allowedModels:[value.model],expectedProvider:'Groq',timeoutMs:30000,leaseSeconds:120};
   })();
   const getDiscovery=async()=>discovery??=discoveryFactory({...config,invocationOptions:{pageSteps:1,reviewBatchSize:16,releaseLeaseOnSuccess:true},runtimeConfig:await getSettings()});
   const getVerifier=async()=>{
    if(typeof verifierFactory!=='function')throw Error('Verification service not installed');
    return verifier??=verifierFactory({...config,runtimeConfig:await getSettings()});
   };
   return await handleAgent(req,authorization,{
    selectRun:async()=>(await getDiscovery()).selectRun(),
    runInvocation:async runId=>(await getDiscovery()).runInvocation(runId),
    verifyInvocation:async()=>(await getVerifier()).runInvocation(),
   });
  }catch{return Response.json({error:'hosted_agent_unavailable',...flags},{status:502});}
 };
}
