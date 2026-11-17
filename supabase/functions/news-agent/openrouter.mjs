import {matchesDiscoveryFormat,validateProviderPolicy,validateReasoningControl} from './review-contract.mjs';
// OpenRouter Chat Completions contract:
// https://openrouter.ai/docs/api_reference/overview
// This adapter owns one HTTP attempt, NOT spend authorization or a durable ledger.
// Caller must atomically reserve a verified worst-case cost under per-run/day caps,
// bind it to this exact request, and persist the attempt before invoking. Never
// reuse a reservation after an uncertain result. No default fetch or key lookup.
const ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const encoder=new TextEncoder();
export class OpenRouterAttemptError extends Error {
 constructor(code,outcome,usage){super(`OpenRouter attempt: ${code}`);this.name='OpenRouterAttemptError';this.code=code;this.outcome=outcome;if(usage)this.usage=usage;}
}
const fail=(code,outcome='not_started',usage)=>{throw new OpenRouterAttemptError(code,outcome,usage);};
const boundedInteger=(v,max)=>Number.isSafeInteger(v)&&v>0&&v<=max;
// HTTP diagnostics are fixed classifications only. Never retain provider messages,
// raw bodies, headers, metadata, prompts or credentials on a thrown error.
const httpErrorCodes=new Set([400,401,402,403,404,408,409,413,422,429,500,502,503,504,529,'rate_limit_exceeded','insufficient_quota','invalid_request_error','authentication_error','permission_error','not_found_error','overloaded_error','api_error','context_length_exceeded','unsupported_parameter']);
const providerErrorTypes=new Set(['invalid_request_error','authentication_error','permission_error','not_found_error','rate_limit_error','overloaded_error','api_error','server_error','insufficient_quota','context_length_exceeded']);
function classifyHttpError(data){
 let nested;
 const raw=data?.error?.metadata?.raw;
 if(typeof raw==='string'){try{nested=JSON.parse(raw);}catch{}}
 else if(raw&&typeof raw==='object')nested=raw;
 const error=data?.error;
 const code=[error?.code,nested?.error?.code,nested?.code].find(value=>httpErrorCodes.has(value));
 const type=[error?.type,nested?.error?.type,nested?.type].find(value=>providerErrorTypes.has(value));
 return {...(code===undefined?{}:{providerErrorCode:code}),...(type===undefined?{}:{providerErrorType:type})};
}

const validGenerationId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value===value.trim()&&!/\p{Cc}/u.test(value);
const validProviderName=value=>typeof value==='string'&&value.length>0&&value.length<=128&&value===value.trim()&&!/\p{Cc}/u.test(value);
function validate(request,config,fetcher){
 if(config.enabled!==true)fail('disabled');
 if(typeof fetcher!=='function'||typeof config.apiKey!=='string'||!config.apiKey.trim()||/[\r\n]/.test(config.apiKey))fail('invalid_transport_configuration');
 if(Object.hasOwn(config,'expectedProvider')&&!validProviderName(config.expectedProvider))fail('invalid_transport_configuration');
 if(!config.reservation||typeof config.reservation.id!=='string'||!config.reservation.id.trim()||!Number.isFinite(config.reservation.maxCostCredits)||config.reservation.maxCostCredits<=0)fail('missing_cost_reservation');
 if(!request||Object.keys(request).some(k=>!['model','max_tokens','messages','response_format','provider','reasoning'].includes(k)))fail('unsupported_request');
 if(typeof request.model!=='string'||!Array.isArray(config.allowedModels)||!config.allowedModels.includes(request.model)||!boundedInteger(request.max_tokens,16384))fail('invalid_model_or_budget');
 if(!Array.isArray(request.messages)||request.messages.length!==2||request.messages[0]?.role!=='system'||request.messages[1]?.role!=='user'||request.messages.some(m=>typeof m.content!=='string'||!m.content||Object.keys(m).some(k=>!['role','content'].includes(k)))||!matchesDiscoveryFormat(request.response_format))fail('invalid_messages');
 if(Object.hasOwn(request,'provider'))validateReviewProvider(request.provider);
 if(Object.hasOwn(request,'reasoning')){try{validateReasoningControl(request.reasoning);}catch{fail('unsupported_request');}}
 let candidates;
 try{candidates=JSON.parse(request.messages[1].content).candidates;}catch{fail('invalid_candidates');}
 if(!Array.isArray(candidates)||!candidates.length)fail('invalid_candidates');
 const ids=new Set();
 for(const c of candidates){if(typeof c?.id!=='string'||!c.id||ids.has(c.id))fail('invalid_candidates');ids.add(c.id);}
 return ids;
}
async function readBounded(response,maxBytes,signal){
 if(!response.body)fail('empty_response','uncertain');
 const contentLength=response.headers.get('content-length');
 if(contentLength!==null&&Number(contentLength)>maxBytes){void response.body.cancel().catch(()=>{});fail('response_too_large','uncertain');}
 if(signal.aborted)fail('timeout','uncertain');
 const reader=response.body.getReader();
 const chunks=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>maxBytes)fail('response_too_large','uncertain');chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_json','uncertain');}
 }finally{signal.removeEventListener('abort',cancel);cancel();}
}
function parseResult(data,request,ids,reservation){
 const u=data?.usage;
 if(!u||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)||u.total_tokens!==u.prompt_tokens+u.completion_tokens||!Number.isFinite(u.cost)||u.cost<0)fail('missing_or_invalid_usage','uncertain');
 const usage={promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens,totalTokens:u.total_tokens,costCredits:u.cost};
 if(u.cost>reservation.maxCostCredits)fail('reservation_exceeded','uncertain',usage);
 if(Object.hasOwn(data??{},'provider')&&!validProviderName(data.provider)||Object.hasOwn(request,'expectedProvider')&&data?.provider!==request.expectedProvider)fail('invalid_completion','uncertain',usage);
 if(data.model!==request.model||!validGenerationId(data.id)||!Array.isArray(data.choices)||data.choices.length!==1||data.choices[0]?.finish_reason!=='stop')fail('invalid_completion','uncertain',usage);
 const completionAudit={model:data.model,generationId:data.id,...(Object.hasOwn(data,'provider')?{provider:data.provider}:{})};
 const decisionFailure=(code,validationIssue,decisionIndex)=>{
  const error=new OpenRouterAttemptError(code,'uncertain',usage);
  error.completionAudit=completionAudit;
  if(validationIssue!==undefined)error.validationIssue=validationIssue;
  if(decisionIndex!==undefined)error.decisionIndex=decisionIndex;
  throw error;
 };
 let parsed;
 try{parsed=JSON.parse(data.choices[0].message.content);}catch{decisionFailure('invalid_decision_json');}
 if(!parsed||Object.keys(parsed).length!==1||!Array.isArray(parsed.decisions)||parsed.decisions.length!==ids.size)decisionFailure('incomplete_decisions');
 const seen=new Set();
 for(const [index,d] of parsed.decisions.entries()){
  let issue;
  if(!d||typeof d!=='object'||Array.isArray(d))issue='invalid_shape';
  else if(Object.keys(d).some(k=>!['id','action','reason'].includes(k)))issue='unexpected_fields';
  else if(!ids.has(d.id))issue='unknown_id';
  else if(seen.has(d.id))issue='duplicate_id';
  else if(!['skip','verify'].includes(d.action))issue='invalid_action';
  else if(typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000)issue='invalid_reason';
  if(issue!==undefined)decisionFailure('invalid_decisions',issue,index);
  seen.add(d.id);
 }
 return {generationId:data.id,model:data.model,...(Object.hasOwn(data,'provider')?{provider:data.provider}:{}),usage,decisions:parsed.decisions};
}
export function validateReviewProvider(provider){
 try{return validateProviderPolicy(provider);}catch{fail('unsupported_request');}
}
export function serializeReviewBody(request){
 if(Object.hasOwn(request,'reasoning')){try{validateReasoningControl(request.reasoning);}catch{fail('unsupported_request');}}
 const provider=Object.hasOwn(request,'provider')?validateReviewProvider(request.provider):{allow_fallbacks:false,require_parameters:true};
 const body=JSON.stringify({...request,stream:false,provider});
 if(encoder.encode(body).byteLength>200000)fail('request_too_large');
 return body;
}
export async function reviewWithOpenRouter(request,config={},fetcher){
 const ids=validate(request,config,fetcher);
 const timeoutMs=config.timeoutMs??10000,maxResponseBytes=config.maxResponseBytes??200000;
 if(!boundedInteger(timeoutMs,30000)||!boundedInteger(maxResponseBytes,200000))fail('invalid_limits');
 const body=serializeReviewBody(request);
 const pinnedRequest={model:request.model,...(Object.hasOwn(config,'expectedProvider')?{expectedProvider:config.expectedProvider}:{})};
 const pinnedReservation={maxCostCredits:config.reservation.maxCostCredits};
 const controller=new AbortController();let timer,httpDiagnostics={};
 const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new OpenRouterAttemptError('timeout','uncertain'),httpDiagnostics));},timeoutMs);});
 const attempt=(async()=>{
  const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body,signal:controller.signal});
  if(!(response instanceof Response))fail('http_failure','uncertain');
  if(!response.ok||response.redirected){
   httpDiagnostics={httpStatus:response.status};
   if(response.redirected){if(response.body)void response.body.cancel().catch(()=>{});}
   else{
    // Diagnostic parsing shares the attempt deadline and a smaller byte ceiling.
    // A missing, malformed or oversized body cannot erase the observed status.
    try{httpDiagnostics={...httpDiagnostics,...classifyHttpError(await readBounded(response,Math.min(maxResponseBytes,8192),controller.signal))};}catch{}
   }
   throw Object.assign(new OpenRouterAttemptError('http_failure','uncertain'),httpDiagnostics);
  }
  if(controller.signal.aborted){if(response.body)void response.body.cancel().catch(()=>{});fail('timeout','uncertain');}
  return parseResult(await readBounded(response,maxResponseBytes,controller.signal),pinnedRequest,ids,pinnedReservation);
 })();
 try{return await Promise.race([attempt,deadline]);}
 catch(error){if(error instanceof OpenRouterAttemptError)throw error;throw new OpenRouterAttemptError('transport_failure','uncertain');}
 finally{clearTimeout(timer);controller.abort();}
}
