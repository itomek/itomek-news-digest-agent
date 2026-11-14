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
function validate(request,config,fetcher){
 if(config.enabled!==true)fail('disabled');
 if(typeof fetcher!=='function'||typeof config.apiKey!=='string'||!config.apiKey.trim()||/[\r\n]/.test(config.apiKey))fail('invalid_transport_configuration');
 if(!config.reservation||typeof config.reservation.id!=='string'||!config.reservation.id.trim()||!Number.isFinite(config.reservation.maxCostCredits)||config.reservation.maxCostCredits<=0)fail('missing_cost_reservation');
 if(!request||Object.keys(request).some(k=>!['model','max_tokens','temperature','messages','response_format'].includes(k)))fail('unsupported_request');
 if(typeof request.model!=='string'||!Array.isArray(config.allowedModels)||!config.allowedModels.includes(request.model)||!boundedInteger(request.max_tokens,16384)||request.temperature!==0)fail('invalid_model_or_budget');
 if(!Array.isArray(request.messages)||request.messages.length!==2||request.messages[0]?.role!=='system'||request.messages[1]?.role!=='user'||request.messages.some(m=>typeof m.content!=='string'||!m.content||Object.keys(m).some(k=>!['role','content'].includes(k)))||request.response_format?.type!=='json_object'||Object.keys(request.response_format).length!==1)fail('invalid_messages');
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
 if(data.model!==request.model||typeof data.id!=='string'||!data.id||data.id.length>256||!Array.isArray(data.choices)||data.choices.length!==1||data.choices[0]?.finish_reason!=='stop')fail('invalid_completion','uncertain',usage);
 let parsed;
 try{parsed=JSON.parse(data.choices[0].message.content);}catch{fail('invalid_decision_json','uncertain',usage);}
 if(!parsed||Object.keys(parsed).length!==1||!Array.isArray(parsed.decisions)||parsed.decisions.length!==ids.size)fail('incomplete_decisions','uncertain',usage);
 const seen=new Set();
 for(const d of parsed.decisions){
  if(!d||Object.keys(d).some(k=>!['id','action','reason'].includes(k))||!ids.has(d.id)||seen.has(d.id)||!['skip','verify'].includes(d.action)||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000)fail('invalid_decisions','uncertain',usage);
  seen.add(d.id);
 }
 return {generationId:data.id,model:data.model,usage,decisions:parsed.decisions};
}
export function serializeReviewBody(request){
 const body=JSON.stringify({...request,stream:false,provider:{allow_fallbacks:false,require_parameters:true}});
 if(encoder.encode(body).byteLength>200000)fail('request_too_large');
 return body;
}
export async function reviewWithOpenRouter(request,config={},fetcher){
 const ids=validate(request,config,fetcher);
 const timeoutMs=config.timeoutMs??10000,maxResponseBytes=config.maxResponseBytes??200000;
 if(!boundedInteger(timeoutMs,30000)||!boundedInteger(maxResponseBytes,200000))fail('invalid_limits');
 const body=serializeReviewBody(request);
 const pinnedRequest={model:request.model};
 const pinnedReservation={maxCostCredits:config.reservation.maxCostCredits};
 const controller=new AbortController();let timer;
 const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OpenRouterAttemptError('timeout','uncertain'));},timeoutMs);});
 const attempt=(async()=>{
  const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body,signal:controller.signal});
  if(!(response instanceof Response)||!response.ok||response.redirected){if(response instanceof Response&&response.body)void response.body.cancel().catch(()=>{});fail('http_failure','uncertain');}
  if(controller.signal.aborted){if(response.body)void response.body.cancel().catch(()=>{});fail('timeout','uncertain');}
  return parseResult(await readBounded(response,maxResponseBytes,controller.signal),pinnedRequest,ids,pinnedReservation);
 })();
 try{return await Promise.race([attempt,deadline]);}
 catch(error){if(error instanceof OpenRouterAttemptError)throw error;throw new OpenRouterAttemptError('transport_failure','uncertain');}
 finally{clearTimeout(timer);controller.abort();}
}
