import {approvedRuntimeModel} from '../../supabase/functions/news-agent/approved-runtime-models.mjs';
import {createHash} from 'node:crypto';
import {evaluateDecisions} from '../../supabase/functions/news-agent/evaluation.mjs';
import {reviewWithOpenRouter,serializeReviewBody,OpenRouterAttemptError} from '../../supabase/functions/news-agent/openrouter.mjs';
const stop=code=>{const e=new Error(code);e.pilotCode=code;throw e;};
export function assertActivePilotModel(model){if(!approvedRuntimeModel(model))stop('pilot_model_not_active');}
export async function executeCanary({request,model,apiKey,expectedProvider,maxCostCredits,ledger,attempt,cases,save,fetcher=fetch}){
 if(typeof model==='string'&&(model.startsWith('nvidia/')||model.startsWith('meta-llama/')))assertActivePilotModel(model);
 const body=serializeReviewBody(request),requestHash=createHash('sha256').update(body).digest('hex');
 ledger.markDispatched(attempt);const started=Date.now();let result;
 try{
  result=await reviewWithOpenRouter(request,{enabled:true,apiKey,allowedModels:[model],expectedProvider,reservation:{id:attempt,maxCostCredits},timeoutMs:30000,maxResponseBytes:200000},async(url,options)=>{
   if(url!=='https://openrouter.ai/api/v1/chat/completions'||options.method!=='POST'||options.body!==body||createHash('sha256').update(options.body).digest('hex')!==requestHash)stop('dispatch_bytes_or_destination_changed');
   return fetcher(url,options);
  });
 }catch(error){
  const cost=error instanceof OpenRouterAttemptError?error.usage?.costCredits:undefined;
  if(Number.isFinite(cost))ledger.settle(attempt,{costUsd:cost,outcome:'failure'});else ledger.markUncertain(attempt);
  const diagnostics={};
  if(error instanceof OpenRouterAttemptError)for(const field of ['httpStatus','providerErrorCode','providerErrorType','validationIssue','decisionIndex','completionAudit'])if(Object.hasOwn(error,field))diagnostics[field]=error[field];
  try{await save(`canary-${attempt}.json`,{status:'canary_failed',code:error instanceof OpenRouterAttemptError?error.code:'operation_failed',...diagnostics,usage:error instanceof OpenRouterAttemptError?error.usage:null,campaign:ledger.snapshot(),publishingEnabled:false});}catch{stop('canary_failure_report_failed_accounting_retained');}
  stop('canary_failed_no_retry');
 }
 // Accounting is independent of evaluation/report I/O. Never reclassify a known
 // settled response as uncertain because an artifact could not be written.
 ledger.settle(attempt,{costUsd:result.usage.costCredits,outcome:'success'});
 let report;
 try{
  report={status:'canary_passed',at:new Date().toISOString(),elapsedMs:Date.now()-started,requestHash,model:result.model,provider:result.provider,generationId:result.generationId,usage:result.usage,decisions:result.decisions,evaluation:evaluateDecisions(cases,result.decisions),modelQualityProven:false,publishingEnabled:false,campaign:ledger.snapshot()};
  await save(`canary-${attempt}.json`,report);
 }catch{stop('canary_report_failed_after_settlement');}
 return report;
}
