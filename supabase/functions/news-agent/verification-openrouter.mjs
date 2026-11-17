import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import {OpenRouterAttemptError,classifyOpenRouterHttpError,openRouterResponseDiagnostics} from './openrouter.mjs';
import {VERIFICATION_RESPONSE_FORMAT,buildVerificationRequest} from './verification-contract.mjs';
import {requestProfileForModel} from './model-profiles.mjs';
// A separate response contract; discovery versions and paid history stay intact.
export const VERIFICATION_REQUEST_PROFILE_VERSION='2026-11-16.verify.1';
const ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const encoder=new TextEncoder();
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,ks)=>plain(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
function equal(a,b){if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((x,i)=>equal(a[i],x));if(plain(b))return keys(a,Object.keys(b))&&Object.keys(b).every(k=>equal(a[k],b[k]));return a===b;}
const integer=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const validIdentity=(s,max)=>typeof s==='string'&&s.trim()===s&&s.length>0&&s.length<=max&&!/\p{Cc}/u.test(s);
const fail=(code,outcome='not_started',usage,audit)=>{const e=new OpenRouterAttemptError(code,outcome,usage);if(audit)e.completionAudit=audit;throw e;};
function matchesSchema(value,schema){
 if(schema.anyOf)return schema.anyOf.some(s=>matchesSchema(value,s));
 if(schema.enum&&!schema.enum.includes(value))return false;
 switch(schema.type){
  case 'object':return keys(value,schema.required)&&Object.entries(schema.properties).every(([k,s])=>matchesSchema(value[k],s));
  case 'array':return Array.isArray(value)&&value.every(v=>matchesSchema(v,schema.items));
  case 'string':return typeof value==='string';
  case 'integer':return Number.isSafeInteger(value);
  case 'boolean':return typeof value==='boolean';
  default:return false;
 }
}
function validate(request,config,fetcher){
 if(config.enabled!==true)fail('disabled');
 const approved=approvedRuntimeModel(request?.model);if(!approved)fail('unsupported_request');
 if(typeof fetcher!=='function'||typeof config.apiKey!=='string'||!config.apiKey.trim()||/[\r\n]/.test(config.apiKey)||config.expectedProvider!==approved.provider||!Array.isArray(config.allowedModels)||!config.allowedModels.includes(approved.model))fail('invalid_transport_configuration');
 if(!keys(config.reservation,['id','maxCostCredits'])||!validIdentity(config.reservation.id,256)||!Number.isFinite(config.reservation.maxCostCredits)||config.reservation.maxCostCredits!==approved.maxCostCredits)fail('missing_cost_reservation');
 const profile=requestProfileForModel(approved.model,approved.discoveryProfileVersion);
 if(!keys(request,['model','max_tokens','provider','reasoning','response_format','messages'])||request.model!==approved.model||!integer(request.max_tokens,approved.maxOutputTokens)||!equal(request.provider,profile.provider)||!equal(request.reasoning,profile.reasoning)||!equal(request.response_format,VERIFICATION_RESPONSE_FORMAT))fail('unsupported_request');
 if(!Array.isArray(request.messages)||request.messages.length!==2||request.messages[0]?.role!=='system'||request.messages[1]?.role!=='user'||request.messages.some(m=>!keys(m,['role','content'])||typeof m.content!=='string'||!m.content))fail('invalid_messages');
 let input;try{input=JSON.parse(request.messages[1].content);}catch{fail('invalid_messages');}
 if(!keys(input,['storyKey','evidenceHash','evidence','sources','history','now']))fail('invalid_messages');
 let canonical;try{canonical=buildVerificationRequest(input,{model:approved.model,maxOutputTokens:request.max_tokens});}catch{fail('invalid_messages');}
 if(!equal(request.messages,canonical.messages))fail('invalid_messages');
 const body=JSON.stringify({...request,stream:false});if(encoder.encode(body).length>750000)fail('request_too_large');
 return body;
}
async function readBounded(response,maxBytes,signal){
 const declared=response.headers.get('content-length');
 if(!response.body||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){if(response.body)void response.body.cancel().catch(()=>{});fail('response_too_large','uncertain');}
 const reader=response.body.getReader(),chunks=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){const {done,value}=await reader.read();if(signal.aborted)fail('timeout','uncertain');if(done)break;size+=value.byteLength;if(size>maxBytes)fail('response_too_large','uncertain');chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_json','uncertain');}}
 finally{signal.removeEventListener('abort',cancel);cancel();}
}
function parse(data,reservation,schema,approved){
 const u=data?.usage;
 if(!u||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)||u.total_tokens!==u.prompt_tokens+u.completion_tokens||!Number.isFinite(u.cost)||u.cost<0)fail('missing_or_invalid_usage','uncertain');
 const usage={promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens,totalTokens:u.total_tokens,costCredits:u.cost};
 const audit={...(validIdentity(data?.id,256)?{generationId:data.id}:{}),...(typeof data?.model==='string'&&data.model===approved.model?{model:data.model}:{}),...(validIdentity(data?.provider,128)?{provider:data.provider}:{})};
 const billedFail=code=>fail(code,'uncertain',usage,audit);
 if(u.cost>reservation.maxCostCredits)billedFail('reservation_exceeded');
 if(data.model!==approved.model||!validIdentity(data.id,256)||data.provider!==approved.provider||!Array.isArray(data.choices)||data.choices.length!==1||data.choices[0]?.finish_reason!=='stop')billedFail('invalid_completion');
 let parsed;try{parsed=JSON.parse(data.choices[0].message.content);}catch{billedFail('invalid_verification_json');}
 if(!matchesSchema(parsed,schema))billedFail('invalid_verification_schema');
 return {generationId:data.id,model:data.model,provider:data.provider,usage,result:parsed.result};
}
export async function verifyWithOpenRouter(request,config={},fetcher){
 const body=validate(request,config,fetcher),timeoutMs=config.timeoutMs??10000,maxResponseBytes=config.maxResponseBytes??200000;
 if(!integer(timeoutMs,30000)||!integer(maxResponseBytes,200000))fail('invalid_limits');
 const approved=approvedRuntimeModel(request.model),key=config.apiKey,reservation={maxCostCredits:config.reservation.maxCostCredits},schema=structuredClone(VERIFICATION_RESPONSE_FORMAT.json_schema.schema);
 const controller=new AbortController();let timer,httpDiagnostics={};
 const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new OpenRouterAttemptError('timeout','uncertain'),httpDiagnostics));},timeoutMs);});
 const operation=(async()=>{
  const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body,signal:controller.signal});
  if(!(response instanceof Response))fail('http_failure','uncertain');
  if(!response.ok||response.redirected){
   httpDiagnostics={httpStatus:response.status,...openRouterResponseDiagnostics(response,key)};
   if(response.redirected){if(response.body)void response.body.cancel().catch(()=>{});}
   else{try{httpDiagnostics={...httpDiagnostics,...classifyOpenRouterHttpError(await readBounded(response,Math.min(maxResponseBytes,8192),controller.signal),key)};}catch{}}
   throw Object.assign(new OpenRouterAttemptError('http_failure','uncertain'),httpDiagnostics);
  }
  if(controller.signal.aborted){if(response.body)void response.body.cancel().catch(()=>{});fail('timeout','uncertain');}
  return parse(await readBounded(response,maxResponseBytes,controller.signal),reservation,schema,approved);
 })();
 try{return await Promise.race([operation,deadline]);}catch(e){if(e instanceof OpenRouterAttemptError)throw e;throw new OpenRouterAttemptError('transport_failure','uncertain');}finally{clearTimeout(timer);controller.abort();}
}
