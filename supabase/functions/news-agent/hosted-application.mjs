import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import {handleAgent} from './handler.mjs';
import {createAgentService} from './services.mjs';
const flags={publishing_enabled:false};
// These reasons are returned only after verification_finish confirms a terminal
// item deferral. Infrastructure/handoff failures and unknown paid outcomes stop.
const finishedItemDeferrals=new Set(['evidence_or_history_unavailable','history_lock_contention','unapproved_primary_source','billed_invalid_completion','unsupported_verification','model_deferred','verification_quote_missing','verification_source_hash_mismatch','verification_date_invalid','verification_claim_coverage_missing','verification_post_unpublishable']);
function bootstrapTransport({projectUrl,serviceKey},fetcher){
 const project=new URL(projectUrl);
 if(project.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(project.hostname)||project.href!==project.origin+'/'||typeof serviceKey!=='string'||!serviceKey||/[\r\n]/.test(serviceKey))throw Error('Invalid hosted configuration');
 return async(name,args={})=>{
  const signature={warpcore_worker_continue:[],warpcore_agent_authorization:[],warpcore_agent_runtime_config:[],warpcore_owner_feedback_checkpoint:[],warpcore_owner_feedback_record_page:['p_revision','p_page']};
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
   const notificationSteps=[];
   const getSettings=()=>settings??=(async()=>{
    const value=await rpc('warpcore_agent_runtime_config');
    const approved=approvedRuntimeModel(value?.model);
    if(!approved||Object.keys(value).length!==5||typeof value.apiKey!=='string'||!value.apiKey||value.maxOutputTokens!==approved.maxOutputTokens||value.maxCostCredits!==approved.maxCostCredits||!Array.isArray(value.allowedSourceHosts)||!value.allowedSourceHosts.length)throw Error();
    return {...value,enabled:true,requireModelProfile:true,allowedModels:[approved.model],expectedProvider:approved.provider,reviewBatchSize:approved.reviewBatchSize,timeoutMs:60000,leaseSeconds:180};
   })();
   const getDiscovery=async()=>{const settings=await getSettings();return discovery??=discoveryFactory({...config,invocationOptions:{pageSteps:10,reviewBatchSize:settings.reviewBatchSize,releaseLeaseOnSuccess:true},runtimeConfig:settings});};
   const getVerifier=async()=>{
    if(typeof verifierFactory!=='function')throw Error('Verification service not installed');
    return verifier??=verifierFactory({...config,runtimeConfig:await getSettings()});
   };
   const service={
    selectRun:async()=>(await getDiscovery()).selectRun(),
    runInvocation:async runId=>{const result=await(await getDiscovery()).runInvocation(runId);notificationSteps.push({...result,mode:'shadow',runId});return result;},
    verifyInvocation:async()=>{
     const result=await(await getVerifier()).runInvocation();
     notificationSteps.push({...result,mode:'verification'});
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
   };
   const now=dependencies.now??(()=>performance.now()),started=now();
   let response=await handleAgent(req,authorization,service);
   if(config.drain!==true)return response;
   const steps=[];
   const finish=async response=>{
    if(typeof dependencies.notifyFailure!=='function'||response.status===400||response.status===401)return response;
    let status='failed';
    try{const body=await response.clone().json();const report=await dependencies.notifyFailure({steps:notificationSteps.length?notificationSteps:steps,error:body.error,httpStatus:response.status,workerObservations:notificationSteps.some(step=>['advanced','submitted','verified'].includes(step.status))?[{entity:'hosted-agent',resolved:['hosted_agent_unavailable','agent_run_failed']}]:[]});if(['sent','failed','timeout','unconfigured','suppressed'].includes(report?.status))status=report.status;}catch{}
    if(status==='suppressed')return response;
    return Response.json({...await response.json(),notification:{status}},{status:response.status});
   };
   for(let i=0;i<12;i++){
    if(response.status!==200)return finish(response);
    const result=await response.clone().json();
    steps.push(result);
    const progressed=['advanced','verified','submitted'].includes(result.status)
     ||result.mode==='verification'&&result.status==='deferred'&&finishedItemDeferrals.has(result.reason);
    if(!progressed)break;
    if(now()-started>=10000||i===11){
     await rpc('warpcore_worker_continue');
     break;
    }
    response=await handleAgent(new Request(req.url,{method:'POST',headers:req.headers,body:'{}'}),authorization,service);
   }
   return finish(Response.json({...await response.json(),steps}));
  }catch{
   try{await dependencies.notifyFailure?.({error:'hosted_agent_unavailable',httpStatus:502});}catch{}
   return Response.json({error:'hosted_agent_unavailable',...flags},{status:502});
  }
 };
}
