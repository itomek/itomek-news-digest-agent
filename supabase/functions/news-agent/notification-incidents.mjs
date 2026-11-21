import {reasons} from './gmail-alerts.mjs';
const sourceClasses=['source_timeout','source_network','source_content_type','source_body_limit','source_parse_failed','source_or_persistence_failed','malformed_source_dates','source_head_stale','source_http_error'];
const itemClasses=[...reasons,'agent_run_failed','hosted_agent_unavailable'];
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_:-]{1,128}$/.test(value);
export function observationsFromReport(report={}){
 const out=[];
 for(const o of (report.workerObservations??[]).slice(0,4))if(['hosted-agent','verification','discovery','collector'].includes(o.entity))out.push({domain:'worker',entity:o.entity,configuration:'v1',classes:[],resolved:(o.resolved??[]).filter(c=>itemClasses.includes(c)||c==='source_or_persistence_failed')});
 for(const s of (report.sourceObservations??[]).slice(0,64)){
  if(!validId(s.id)||!validId(s.generation)||s.generation.length>64)continue;
  if(!Number.isSafeInteger(s.sourceGeneration)||s.sourceGeneration<1){if((s.classes??[]).length)out.push({domain:'worker',entity:'collector',configuration:'v1',classes:['source_or_persistence_failed'],resolved:[]});continue;}
  out.push({domain:'source',entity:s.id,configuration:s.sourceGeneration+':'+s.generation,classes:(s.classes??[]).map(c=>/^source_http_[1-5][0-9]{2}$/.test(c)?'source_http_error':c).filter(c=>sourceClasses.includes(c)),resolved:(s.resolved??[]).filter(c=>sourceClasses.includes(c))});
 }
 for(const s of (report.steps??[]).slice(0,12)){
  if(s.mode==='verification'&&s.status==='idle')out.push({domain:'worker',entity:'verification',configuration:'v1',classes:[],resolved:['invalid_configuration','claim_unavailable','invalid_claim']});
  const entity=s.jobId??s.runId;
  if(!validId(entity)){
   const cls=itemClasses.includes(s.reason)?s.reason:itemClasses.includes(s.error)?s.error:null;
   if(cls)out.push({domain:'worker',entity:s.mode==='verification'?'verification':'discovery',configuration:'v1',classes:[cls],resolved:[]});
   continue;
  }
  if(s.mode==='verification')out.push({domain:'worker',entity:'verification',configuration:'v1',classes:[],resolved:['invalid_configuration','claim_unavailable','invalid_claim']});
  const classes=itemClasses.includes(s.reason)?[s.reason]:itemClasses.includes(s.error)?[s.error]:[];
  const successful=['verified','submitted'].includes(s.status)||s.mode==='shadow'&&s.status==='advanced';
  if(classes.length||successful)out.push({domain:s.mode==='verification'?'verification':'discovery',entity,configuration:'v1',classes,resolved:successful?itemClasses:[]});
 }
 if(report.error==='checkpoint_persistence_unavailable')out.push({domain:'worker',entity:'collector',configuration:'v1',classes:['source_or_persistence_failed'],resolved:[]});
 if(report.error==='hosted_agent_unavailable'||report.error==='agent_run_failed')out.push({domain:'worker',entity:'hosted-agent',configuration:'v1',classes:[report.error],resolved:[]});
 return out;
}
export function createIncidentStore({projectUrl,serviceKey},fetcher=fetch){
 const project=new URL(projectUrl);
 if(project.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(project.hostname)||project.href!==project.origin+'/'||typeof serviceKey!=='string'||!serviceKey||/[\r\n]/.test(serviceKey))throw Error('Invalid notification configuration');
 const rpc=async(name,args,context={})=>{
  const signal=context.signal??AbortSignal.timeout(5000);if(signal.aborted)throw Error('Notification aborted');
  const response=await fetcher(new URL('/rest/v1/rpc/warpcore_notification_'+name,project),{method:'POST',redirect:'error',signal,headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)});
  if(!response.ok||response.redirected)throw Error('Notification persistence unavailable');
  // RPC responses contain only bounded scalar metadata.
  if(!response.body)throw Error('Notification response missing');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  try{for(;;){const {done,value}=await reader.read();if(signal.aborted)throw Error('Notification aborted');if(done)break;size+=value.byteLength;if(size>4096)throw Error('Notification response too large');chunks.push(value);}}finally{signal.removeEventListener('abort',cancel);cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
 };
 return {observeBatch:(observations,context)=>rpc('observe_batch',{p_observations:observations},context),claim:context=>rpc('claim',{},context),ack:(id,token,status,context)=>rpc('ack',{p_id:id,p_token:token,p_status:status},context)};
}
export function createIncidentNotifier({store,send,configured=()=>true,budgetMs=10000}){
 return async report=>{
  let status='suppressed',expired=false,timer;
  const controller=new AbortController(),deadline=Date.now()+Math.max(1,Math.min(10000,budgetMs));
  const context={signal:controller.signal,remainingMs:()=>Math.max(0,deadline-Date.now())};
  const check=()=>{if(expired||Date.now()>=deadline){expired=true;controller.abort();throw Error('Notification deadline');}};
  const operation=(async()=>{try{
   check();await store.observeBatch(observationsFromReport(report),context);check();
   if(!configured())return {status:'unconfigured'};
   for(let i=0;i<12;i++){
    check();const incident=await store.claim(context);check();if(!incident)break;
    let delivery;try{delivery=await send({incident},context);}catch{delivery={status:'failed'};}
    check();status=['sent','failed','timeout'].includes(delivery?.status)?delivery.status:'failed';
    await store.ack(incident.id,incident.token,status,context);
   }
   return {status};
  }catch{return {status:expired?'timeout':'failed'};}})();
  try{return await Promise.race([operation,new Promise(resolve=>{timer=setTimeout(()=>{expired=true;controller.abort();resolve({status:'timeout'});},Math.max(1,Math.min(10000,budgetMs)));})]);}finally{clearTimeout(timer);}
 };
}
export function gmailConfigured(account,password){return typeof account==='string'&&/^[A-Za-z0-9._%+-]+@gmail\.com$/.test(account)&&typeof password==='string'&&/^[A-Za-z0-9]{16}$/.test(password.replace(/ /g,''));}

export function createHostedIncidentNotifier({projectUrl,serviceKey,account,password,createTransport},sendFactory){
 return async report=>{
  try{return await createIncidentNotifier({store:createIncidentStore({projectUrl,serviceKey}),configured:()=>gmailConfigured(account,password),send:sendFactory({account,password,createTransport})})(report);}catch{return {status:'failed'};}
 };
}
