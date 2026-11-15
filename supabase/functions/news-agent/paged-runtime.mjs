import {requestProfileForModel} from './model-profiles.mjs';
import {POLICY_VERSION} from './policy.mjs';
import {buildReviewRequest} from './evaluation.mjs';
import {reviewWithOpenRouter,serializeReviewBody,OpenRouterAttemptError} from './openrouter.mjs';
const flags={publishingEnabled:false,modelQualityProven:false};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const errorCodes=new Set(['disabled','invalid_transport_configuration','missing_cost_reservation','unsupported_request','invalid_model_or_budget','invalid_messages','invalid_candidates','empty_response','response_too_large','timeout','invalid_json','missing_or_invalid_usage','reservation_exceeded','invalid_completion','invalid_decision_json','incomplete_decisions','invalid_decisions','request_too_large','invalid_limits','http_failure','transport_failure']);
const key=/^[a-f0-9]{64}$/;
const fields=['storageKind','runId','scanStartedAt','policyVersion','revision','phase','cursor','candidateCount','reviewedCount','activeBatch','publishingEnabled'];
const integer=(n,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export function newPagedShadowRun({runId,scanStartedAt}={}){
 if(!uuid.test(runId??'')||!Number.isFinite(Date.parse(scanStartedAt)))throw Error('Run identity and fixed scan timestamp required');
 return {storageKind:'paged-v1',runId,scanStartedAt,policyVersion:POLICY_VERSION,revision:0,phase:'scan',cursor:null,candidateCount:0,reviewedCount:0,activeBatch:null,publishingEnabled:false};
}
function validateState(state,runId){
 if(!state||Object.keys(state).length!==fields.length||fields.some(k=>!Object.hasOwn(state,k))||state.storageKind!=='paged-v1'||state.runId!==runId||state.policyVersion!==POLICY_VERSION||state.publishingEnabled!==false||!Number.isFinite(Date.parse(state.scanStartedAt))||!integer(state.revision,0)||!integer(state.candidateCount,0)||!integer(state.reviewedCount,0,state.candidateCount)||!['scan','review','reviewing','uncertain','complete'].includes(state.phase))throw Error('Invalid compact checkpoint');
 if(state.candidateCount===0?state.cursor!==null:!key.test(state.cursor??''))throw Error('Invalid cursor');
 if(state.phase==='scan'&&state.reviewedCount!==0||state.phase==='complete'&&state.reviewedCount!==state.candidateCount)throw Error('Invalid coverage');
 if(['reviewing','uncertain'].includes(state.phase)){
  if(!Array.isArray(state.activeBatch)||!integer(state.activeBatch.length,1,Math.min(100,state.candidateCount-state.reviewedCount))||state.activeBatch.some((id,i)=>!key.test(id)||i>0&&id<=state.activeBatch[i-1]))throw Error('Invalid active batch');
 }else if(state.activeBatch!==null)throw Error('Unexpected active batch');
 return structuredClone(state);
}
function projectCandidates(page,cursor){
 if(!Array.isArray(page)||page.length>100)throw Error('Invalid candidate page');
 return page.map(c=>{
  if(!c||!key.test(c.id??'')||cursor!==null&&c.id<=cursor||typeof c.discoveryText!=='string'||!c.discoveryText||typeof c.sourceUrl!=='string')throw Error('Invalid candidate');
  const url=new URL(c.sourceUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid candidate URL');
  cursor=c.id;
  return {id:c.id,sourceUrl:c.sourceUrl,sourceType:c.sourceType,sourceCreatedAt:c.sourceCreatedAt,discoveryText:c.discoveryText};
 });
}
// Disabled injected seam only: no connection, credentials lookup, cron or publisher.
// SQL owns normalized candidate/decision rows and atomic lease/CAS transitions.
export async function runPagedShadowInvocation({runId,config={},query,fetcher,fetchPage,now=()=>performance.now()}={},options={}){
 if(config.enabled!==true)return {status:'disabled',...flags};
 const cfg=structuredClone(config),{pageSteps=1,reviewBatchSize=25}=options;
 // Profiles are code-owned; source/caller metadata cannot replace routing or prices.
 delete cfg.requestProfile;
 const requestProfile=requestProfileForModel(cfg.model);
 if(requestProfile)cfg.requestProfile=requestProfile;
 else if(cfg.requireModelProfile===true)throw Error('Researched model profile required');
 const leaseSeconds=cfg.leaseSeconds??60,timeoutMs=cfg.timeoutMs??10000,maxResponseBytes=cfg.maxResponseBytes??200000;
 if(!uuid.test(runId??'')||typeof query!=='function'||typeof fetcher!=='function'||typeof now!=='function'||!Array.isArray(cfg.allowedModels)||!cfg.allowedModels.includes(cfg.model)||!integer(cfg.maxOutputTokens,1,16384)||!Number.isFinite(cfg.maxCostCredits)||cfg.maxCostCredits<=0||cfg.maxCostCredits>=1000000||typeof cfg.apiKey!=='string'||!cfg.apiKey.trim()||/[\r\n]/.test(cfg.apiKey)||!integer(leaseSeconds,1,300)||!integer(timeoutMs,1,30000)||!integer(maxResponseBytes,1,200000)||leaseSeconds*1000<timeoutMs+5000||!integer(pageSteps,1,10)||!integer(reviewBatchSize,1,100))throw Error('Invalid paged runtime configuration');
 let lastTime=now();if(!Number.isFinite(lastTime))throw Error('Invalid monotonic clock');
 const deadline=lastTime+leaseSeconds*1000;
 const requireMargin=()=>{const current=now();if(!Number.isFinite(current)||current<lastTime||deadline-current<timeoutMs+5000)throw Error('Insufficient remaining lease');lastTime=current;};
 const call=async(op,args)=>{
  const result=await query(`select shadow_agent.${op}(${args.map((_,i)=>`$${i+1}`).join(',')}) as value`,args);
  if(!Array.isArray(result?.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],'value'))throw Error('Invalid SQL response');
  return result.rows[0].value;
 };
 try{
  const lease=await call('claim',[runId,leaseSeconds]);if(lease===null)return {status:'busy',...flags};
  if(typeof lease!=='string'||!lease)throw Error('Invalid lease');
  let state=validateState(await call('load',[runId]),runId);
  const binding={model:cfg.model,maxOutputTokens:cfg.maxOutputTokens,maxCostCredits:cfg.maxCostCredits,timeoutMs,maxResponseBytes,policyVersion:POLICY_VERSION,routing:'openrouter-no-fallback',...(requestProfile?{requestProfile}: {})};
  if(await call('paged_bind_config',[runId,lease,binding])!==true)throw Error('Configuration binding unconfirmed');
  const adopt=(value,patch)=>{
   const next=validateState(value,runId),expected={...state,...patch,revision:state.revision+1};
   if(fields.some(k=>JSON.stringify(next[k])!==JSON.stringify(expected[k])))throw Error('Unexpected checkpoint transition');
   state=next;return state;
  };
  if(['reviewing','uncertain'].includes(state.phase))throw Error('Manual reconciliation required');
  if(state.phase==='scan'){
   if(typeof fetchPage!=='function')throw Error('Candidate source required');
   for(let i=0;i<pageSteps;i++){
    const page=projectCandidates(await fetchPage({cursor:state.cursor,scanStartedAt:state.scanStartedAt}),state.cursor);
    const value=await call('paged_append',[runId,lease,state.revision,page]);
    adopt(value,page.length?{cursor:page.at(-1).id,candidateCount:state.candidateCount+page.length}:{phase:'review'});
    if(page.length===0)break;
   }
  }else if(state.phase==='review'){
   const remaining=state.candidateCount-state.reviewedCount;
   const preview=projectCandidates(await call('paged_preview',[runId,lease,state.revision,reviewBatchSize]),null);
   if(preview.length>Math.min(reviewBatchSize,remaining)||(remaining===0?preview.length!==0:preview.length===0))throw Error('Incomplete review preview');
   // Fit exact serialized HTTP bytes before freezing any batch or reserving credit.
   // Shrinking invocation work never skips a candidate or limits total review.
   let size=preview.length;
   while(size>0){
    try{serializeReviewBody(buildReviewRequest(preview.slice(0,size),cfg));break;}
    catch(error){if(!(error instanceof OpenRouterAttemptError)||error.code!=='request_too_large')throw error;size--;}
   }
   if(remaining>0&&size===0)return {status:'deferred',reason:'candidate_request_too_large',state,...flags};
   const begun=await call('paged_begin',[runId,lease,state.revision,size||reviewBatchSize]);
   const batch=projectCandidates(begun?.batch,null);
   if(batch.length!==size||JSON.stringify(batch)!==JSON.stringify(preview.slice(0,size)))throw Error('Frozen batch differs from preview');
   adopt(begun?.state,batch.length?{phase:'reviewing',activeBatch:batch.map(c=>c.id)}:{phase:'complete'});
   if(batch.length){
    try{
     const request=buildReviewRequest(batch,cfg);
     const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serializeReviewBody(request)));
     const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
     requireMargin();
     const reservation=await call('paged_reserve',[runId,lease,state.revision,hash,cfg.maxCostCredits]);
     if(reservation?.status==='deferred'){
      if(!['insufficient_budget','missing_daily_budget','spending_blocked'].includes(reservation.reason))throw Error('Invalid deferral reason');
      adopt(reservation.state,{phase:'review',activeBatch:null});
      return {status:'deferred',reason:reservation.reason,state,...flags};
     }
     const attempt=reservation?.attemptId;
     if(reservation?.status!=='reserved'||typeof attempt!=='string'||!attempt)throw Error('Invalid reservation');
     requireMargin();
     if(await call('dispatch',[attempt,lease])!==true)throw Error('Dispatch not confirmed');
     requireMargin();
     let result;
     try{result=await reviewWithOpenRouter(request,{...cfg,reservation:{id:attempt,maxCostCredits:cfg.maxCostCredits}},fetcher);}
     catch(error){
      const usage=error instanceof OpenRouterAttemptError?error.usage:undefined,cost=usage?.costCredits;
      const errorCode=error instanceof OpenRouterAttemptError&&errorCodes.has(error.code)?error.code:'transport_failure';
      await call('paged_settle',[attempt,lease,Number.isFinite(cost)?'settled':'uncertain',Number.isFinite(cost)?cost:null,Number.isFinite(cost)?{usage,errorCode}:{errorCode}]);
      throw Error('Model attempt unsuccessful');
     }
     if(await call('paged_settle',[attempt,lease,'settled',result.usage.costCredits,{model:result.model,generationId:result.generationId,usage:result.usage}])!==true)throw Error('Settlement unconfirmed');
     // Store in frozen candidate order even if the provider reorders decisions.
     const decisions=batch.map(c=>result.decisions.find(d=>d.id===c.id));
     adopt(await call('paged_commit',[runId,lease,state.revision,decisions]),{phase:'review',activeBatch:null,reviewedCount:state.reviewedCount+batch.length});
    }catch(error){
     try{adopt(await call('paged_uncertain',[runId,lease,state.revision]),{phase:'uncertain'});}catch{}
     throw error;
    }
   }
  }
  return {status:'advanced',state,...flags};
 }catch{throw Error('Paged shadow invocation stopped; inspect durable state and reconcile before retry');}
}
