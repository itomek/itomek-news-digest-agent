import {advanceShadowRun} from './workflow.mjs';
import {buildReviewRequest} from './evaluation.mjs';
import {reviewWithOpenRouter,serializeReviewBody} from './openrouter.mjs';
const flags={publishingEnabled:false,modelQualityProven:false};
// Isolated injected SQL runtime, not a hosted handler or authorization mechanism.
// Caller owns verified worst-case pricing, approved spend and durable SQL setup.
// No env reads, connection defaults, retries, publisher, credentials lookup or cron.
export async function runShadowInvocation({runId,config={},query,fetcher,fetchPage}={},options={}){
 if(config.enabled!==true)return {status:'disabled',...flags};
 const cfg=structuredClone(config);
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runId??'')||typeof query!=='function'||typeof fetcher!=='function'||
 !Array.isArray(cfg.allowedModels)||!cfg.allowedModels.includes(cfg.model)||!Number.isSafeInteger(cfg.maxOutputTokens)||cfg.maxOutputTokens<1||cfg.maxOutputTokens>16384||
 !Number.isFinite(cfg.maxCostCredits)||cfg.maxCostCredits<=0||cfg.maxCostCredits>=1000000||typeof cfg.apiKey!=='string'||!cfg.apiKey.trim()||/[\r\n]/.test(cfg.apiKey))throw Error('Invalid shadow runtime configuration');
 const leaseSeconds=cfg.leaseSeconds??60;
 const timeoutMs=cfg.timeoutMs??10000,maxResponseBytes=cfg.maxResponseBytes??200000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>200000||leaseSeconds*1000<timeoutMs+5000)throw Error('Invalid transport limits or insufficient lease margin');
 if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)throw Error('Invalid shadow lease');
 const call=async(sql,args)=>{
  const result=await query(sql,args);
  if(!Array.isArray(result?.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],'value'))throw Error('Invalid SQL result');
  return result.rows[0].value;
 };
 try{
  const lease=await call('select shadow_agent.claim($1,$2) as value',[runId,leaseSeconds]);
  if(lease===null)return {status:'busy',...flags};
  if(typeof lease!=='string'||!lease)throw Error('Invalid lease result');
  const previous=await call('select shadow_agent.load($1) as value',[runId]);
  if(previous?.runId!==runId)throw Error('Run identity mismatch');
  const state=await advanceShadowRun(previous,{
   fetchPage,
   save:async(next,revision)=>{
    if(await call('select shadow_agent.save($1,$2,$3,$4) as value',[runId,lease,revision,next])!==true)throw Error('Lease or checkpoint lost');
   },
   review:async(batch)=>{
    const request=buildReviewRequest(batch,cfg);
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serializeReviewBody(request)));
    const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
    const attempt=await call('select shadow_agent.reserve($1,$2,$3,$4) as value',[runId,lease,hash,cfg.maxCostCredits]);
    if(typeof attempt!=='string'||!attempt)throw Error('Invalid reservation result');
    // An uncertain reserve/dispatch response NEVER permits HTTP or retry.
    if(await call('select shadow_agent.dispatch($1,$2) as value',[attempt,lease])!==true)throw Error('Dispatch not confirmed');
    let result;
    try{result=await reviewWithOpenRouter(request,{...cfg,reservation:{id:attempt,maxCostCredits:cfg.maxCostCredits}},fetcher);}
    catch(error){
     const cost=error?.usage?.costCredits;
     // If accounting fails, the original durable hold still prevents overspend.
     await call('select shadow_agent.settle($1,$2,$3,$4) as value',[attempt,lease,Number.isFinite(cost)?'settled':'uncertain',Number.isFinite(cost)?cost:null]);
     throw Error('Shadow model attempt unsuccessful');
    }
    if(await call('select shadow_agent.settle($1,$2,$3,$4) as value',[attempt,lease,'settled',result.usage.costCredits])!==true)throw Error('Settlement unconfirmed');
    return result.decisions;
   },
  },options);
  return {status:'advanced',state,...flags};
 }catch{throw Error('Shadow invocation stopped; inspect durable state and reconcile before retry');}
}
