import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import {handleAgent} from './handler.mjs';
import {createAgentService} from './services.mjs';
const flags={publishing_enabled:false};
function bootstrapTransport({projectUrl,serviceKey},fetcher){
 const project=new URL(projectUrl);
 if(project.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(project.hostname)||project.href!==project.origin+'/'||typeof serviceKey!=='string'||!serviceKey||/[\r\n]/.test(serviceKey))throw Error('Invalid hosted configuration');
 return async(name,args={})=>{
  const signature={warpcore_agent_authorization:[],warpcore_agent_runtime_config:[],warpcore_owner_feedback_checkpoint:[],warpcore_owner_feedback_record_page:['p_revision','p_page']};
  const fields=Object.hasOwn(signature,name)?signature[name]:undefined;
  if(!fields)throw Error('Invalid bootstrap operation');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==fields.length||fields.some(k=>!Object.hasOwn(args,k)))throw Error('Invalid bootstrap arguments');
  if(name==='warpcore_owner_feedback_record_page'&&(!Number.isSafeInteger(args.p_revision)||args.p_revision<0||!args.p_page||typeof args.p_page!=='object'||Array.isArray(args.p_page)))throw Error('Invalid feedback arguments');
  let body;try{body=JSON.stringify(args);}catch{throw Error('Invalid bootstrap arguments');}
  if(new TextEncoder().encode(body).length>200000)throw Error('Bootstrap request too large');
  const controller=new AbortController();let timer;
  const operation=(async()=>{
   const response=await fetcher(new URL('/rest/v1/rpc/'+name,project),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body});
   if(!(response instanceof Response)||!response.ok||response.redirected||!response.body)throw Error();
   const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>32000)){void response.body.cancel().catch(()=>{});throw Error();}
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
    const approved=approvedRuntimeModel(value?.model);
    if(!approved||Object.keys(value).length!==5||typeof value.apiKey!=='string'||!value.apiKey||value.maxOutputTokens!==approved.maxOutputTokens||value.maxCostCredits!==approved.maxCostCredits||!Array.isArray(value.allowedSourceHosts)||!value.allowedSourceHosts.length)throw Error();
    return {...value,enabled:true,requireModelProfile:true,allowedModels:[approved.model],expectedProvider:approved.provider,reviewBatchSize:approved.reviewBatchSize,timeoutMs:60000,leaseSeconds:180};
   })();
   const getDiscovery=async()=>{const settings=await getSettings();return discovery??=discoveryFactory({...config,invocationOptions:{pageSteps:1,reviewBatchSize:settings.reviewBatchSize,releaseLeaseOnSuccess:true},runtimeConfig:settings});};
   const getVerifier=async()=>{
    if(typeof verifierFactory!=='function')throw Error('Verification service not installed');
    return verifier??=verifierFactory({...config,runtimeConfig:await getSettings()});
   };
   return await handleAgent(req,authorization,{
    selectRun:async()=>(await getDiscovery()).selectRun(),
    runInvocation:async runId=>(await getDiscovery()).runInvocation(runId),
    verifyInvocation:async()=>{
     const result=await(await getVerifier()).runInvocation();
     if(result?.status==='idle'&&typeof dependencies.runOwnerFeedbackInvocation==='function'){
      const db={
       checkpoint:(...args)=>{if(args.length)throw Error('Invalid feedback arguments');return rpc('warpcore_owner_feedback_checkpoint',{});},
       recordPage:(...args)=>{if(args.length!==2)throw Error('Invalid feedback arguments');return rpc('warpcore_owner_feedback_record_page',{p_revision:args[0],p_page:args[1]});},
      };
      try{const feedback=await dependencies.runOwnerFeedbackInvocation({db});if(!['advanced','disabled','conflict'].includes(feedback?.status))throw Error();}
      catch{throw Error('Owner feedback unavailable');}
     }
     return result;
    },
   });
  }catch{return Response.json({error:'hosted_agent_unavailable',...flags},{status:502});}
 };
}
