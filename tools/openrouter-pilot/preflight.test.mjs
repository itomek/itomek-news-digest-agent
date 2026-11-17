import test from 'node:test';import assert from 'node:assert/strict';
import {reservationEnvelope,fundingReady,campaignBlockReason,requireZdrEndpoint} from './preflight.mjs';
const endpoint={tag:'anthropic',provider_name:'Anthropic',service_tier:null,context_length:1000000,max_completion_tokens:128000,supported_parameters:['max_tokens','response_format','structured_outputs','reasoning'],pricing:{prompt:'0.0000001',completion:'0.0000005',input_cache_write_1h:'0.0000002',overrides:[{min_prompt_tokens:100000,prompt:'0.0000005',completion:'0.0000025',input_cache_write_1h:'0.000001'}]}};
test('preflight cannot report dispatch readiness through unresolved, replay or exhausted campaign',()=>{
 const campaign={blocked:false,inFlightAttempts:0,attemptCount:0,maxAttempts:24,budgetMicrousd:'2000000',heldMicrousd:'0',spentMicrousd:'0',attempts:[]};
 const request={requestHash:'same',reservationUsd:1.32};
 assert.equal(campaignBlockReason(campaign,request),null);
 assert.equal(campaignBlockReason({...campaign,inFlightAttempts:1},request),'attempt_requires_reconciliation');
 assert.equal(campaignBlockReason({...campaign,attempts:[{requestHash:'same'}]},request),'request_already_attempted');
 assert.equal(campaignBlockReason({...campaign,blocked:true},request),'campaign_spending_blocked');
 assert.equal(campaignBlockReason({...campaign,attemptCount:24},request),'campaign_attempt_limit');
 assert.equal(campaignBlockReason({...campaign,spentMicrousd:'700000'},request),'campaign_budget_insufficient');
});
test('reservation uses full advertised maxima and highest cache/long-context rates, not bytes',()=>{
 const v=reservationEnvelope(endpoint);assert.equal(v.reservationUsd,1.32);assert.equal(v.expectedProvider,'Anthropic');assert.equal(v.contextTokens,1000000);assert.equal(v.completionTokens,128000);
});
test('missing capabilities, unbounded extra charges and another provider fail closed',()=>{
 for(const patch of [{tag:'other'},{context_length:0},{max_completion_tokens:null},{supported_parameters:['max_tokens']},{pricing:{...endpoint.pricing,request:'0.1'}},{pricing:{...endpoint.pricing,unknown_charge:'0.1'}}])assert.throws(()=>reservationEnvelope({...endpoint,...patch}));
});
test('an API key limit is not a funded balance and management credentials are refused',()=>{
 const key={is_management_key:false,is_provisioning_key:false,is_free_tier:false,limit_remaining:50};
 assert.equal(fundingReady(key,{total_credits:0,total_usage:0},1.32),false);
 assert.equal(fundingReady(key,{total_credits:5,total_usage:1},1.32),true);
 assert.equal(fundingReady({...key,limit_remaining:1},{total_credits:5,total_usage:1},1.32),false);
 assert.equal(fundingReady({...key,is_management_key:true},{total_credits:5,total_usage:1},1.32),false);
 assert.equal(fundingReady({...key,is_free_tier:true},{total_credits:5,total_usage:1},1.32),false);
});
const lunaModel='openai/gpt-5.6-luna';
const lunaEndpoint={tag:'openai',provider_name:'OpenAI',model_id:lunaModel,service_tier:null,context_length:1050000,max_completion_tokens:128000,supported_parameters:['max_tokens','response_format','structured_outputs','reasoning'],pricing:{prompt:'0.0000004',completion:'0.0000018',input_cache_write:'0.0000005'}};
test('independent Luna envelope uses OpenAI profile ceilings and the highest cache rate',()=>{
 const value=reservationEnvelope(lunaEndpoint,lunaModel);
 assert.equal(value.expectedProvider,'OpenAI');assert.equal(value.contextTokens,1050000);assert.equal(value.completionTokens,128000);
 assert.equal(value.maxInputUsdPerToken,0.0000005);assert.ok(value.maxOutputUsdPerToken>=0.0000018&&value.maxOutputUsdPerToken<=0.000001800000000000001);assert.ok(value.reservationUsd>=0.7554&&value.reservationUsd<=0.755401);
 assert.equal(reservationEnvelope(endpoint,'anthropic/claude-haiku-5.5').reservationUsd,1.32);
});
test('historical pilot models retain exact endpoint identities and unknown models fail closed',()=>{
 for(const model of ['unknown/model','google/gemini-3.8-flash','openai/gpt-5.6-luna:free','qwen/qwen3.6-35b-a3b','deepseek/deepseek-v4-flash-0731',null])assert.throws(()=>reservationEnvelope(lunaEndpoint,model));
 for(const patch of [{tag:'anthropic'},{provider_name:'Anthropic'},{provider_name:'openai'},{model_id:'anthropic/claude-haiku-5.5'},{model_id:null}])assert.throws(()=>reservationEnvelope({...lunaEndpoint,...patch},lunaModel));
 const {model_id,...withoutId}=lunaEndpoint;assert.ok(reservationEnvelope(withoutId,lunaModel).reservationUsd>=0.7554&&reservationEnvelope(withoutId,lunaModel).reservationUsd<=0.755401);
 assert.throws(()=>reservationEnvelope({...endpoint,model_id:lunaModel}));
});
test('Luna retains every capability, charge, routing-rate and campaign reservation guard',()=>{
 for(const patch of [
  {service_tier:'flex'},{context_length:10000001},{max_completion_tokens:0},{supported_parameters:['max_tokens','response_format','structured_outputs']},
  {pricing:{...lunaEndpoint.pricing,prompt:'0.000000400001'}},{pricing:{...lunaEndpoint.pricing,completion:'0.000001800001'}},
  {pricing:{...lunaEndpoint.pricing,request:'0.001'}},{pricing:{...lunaEndpoint.pricing,unknown_fee:'0.001'}},
  {pricing:{...lunaEndpoint.pricing,overrides:[{completion:'0.0000019'}]}},
  {pricing:{...lunaEndpoint.pricing,input_cache_write:'0.001'}},
 ])assert.throws(()=>reservationEnvelope({...lunaEndpoint,...patch},lunaModel));
 const campaign={blocked:false,inFlightAttempts:0,attemptCount:0,maxAttempts:24,budgetMicrousd:'2000000',heldMicrousd:'0',spentMicrousd:'1320000',attempts:[]};
 assert.equal(campaignBlockReason(campaign,{requestHash:'new-luna-request',reservationUsd:0.7554}),'campaign_budget_insufficient');
});
const gemma26Model='google/gemma-4-26b-a4b-it',gemma31Model='google/gemma-4-31b-it';
const gemma26Endpoint={tag:'primeintellect/bf16',provider_name:'PrimeIntellect',model_id:gemma26Model,safety_retention:false,service_tier:null,context_length:262144,max_completion_tokens:32768,supported_parameters:['max_tokens','response_format','structured_outputs','reasoning'],pricing:{prompt:'0.000000042',completion:'0.000000126',input_cache_read:'0.000000021'}};
const gemma31Endpoint={...gemma26Endpoint,tag:'deepinfra/fp8',provider_name:'DeepInfra',model_id:gemma31Model,context_length:262144,max_completion_tokens:16384,pricing:{prompt:'0.00000020',completion:'0.00000040'}};
test('Gemma pilot endpoints retain exact provider pins and conservative price envelopes',()=>{
 const q=reservationEnvelope(gemma26Endpoint,gemma26Model);assert.equal(q.expectedProvider,'PrimeIntellect');assert.ok(q.reservationUsd>=0.021627&&q.reservationUsd<=0.021628);
 assert.equal(reservationEnvelope({...gemma26Endpoint,pricing:{prompt:'0.00000001',completion:'0.0000001'}},gemma26Model).reservationUsd,q.reservationUsd,'reservation floors at approved routing caps');
 const d=reservationEnvelope(gemma31Endpoint,gemma31Model);assert.equal(d.expectedProvider,'DeepInfra');assert.ok(d.reservationUsd>=0.058983&&d.reservationUsd<=0.058984);
 for(const [endpoint,model]of [[gemma26Endpoint,gemma26Model],[gemma31Endpoint,gemma31Model]]){
  assert.throws(()=>reservationEnvelope({...endpoint,tag:endpoint.tag.split('/')[0]},model));
  assert.throws(()=>reservationEnvelope({...endpoint,model_id:'other/model'},model));
  assert.throws(()=>reservationEnvelope({...endpoint,pricing:{...endpoint.pricing,prompt:'0.000001'}},model));
 }
});
test('ZDR gate requires exact endpoint and catalog identities with explicit false retention',()=>{
 for(const [endpoint,model]of [[gemma26Endpoint,gemma26Model],[gemma31Endpoint,gemma31Model]]){
  const catalog={...endpoint,pricing:{prompt:'0.000000001',completion:'0.000000002'}};
  assert.equal(requireZdrEndpoint(endpoint,model,[catalog]),true,'ZDR catalog prices need not equal independently capped model-endpoint prices');
  const {safety_retention,...regularEndpoint}=endpoint;
  assert.equal(requireZdrEndpoint(regularEndpoint,model,[catalog]),true,'regular model endpoint may omit retention; the exact ZDR row supplies explicit false');
  for(const rows of [null,{},[],[{...catalog,safety_retention:true}],[{...catalog,safety_retention:undefined}],[{...catalog,tag:'other/fp8'}],[{...catalog,model_id:'other/model'}],[{...catalog,provider_name:'other'}],[catalog,catalog],[{...catalog,service_tier:'flex'}]])assert.throws(()=>requireZdrEndpoint(endpoint,model,rows));
  for(const patch of [{tag:'other/fp8'},{model_id:'other/model'},{model_id:undefined},{provider_name:'other'},{safety_retention:true},{safety_retention:null},{safety_retention:undefined}])assert.throws(()=>requireZdrEndpoint({...endpoint,...patch},model,[catalog]));
  assert.throws(()=>requireZdrEndpoint(endpoint,'unknown/model',[catalog]));
 }
});

const ossModel='openai/gpt-oss-120b';
const ossEndpoint={tag:'groq',provider_name:'Groq',model_id:ossModel,service_tier:null,context_length:131072,max_completion_tokens:65536,supported_parameters:['max_tokens','response_format','structured_outputs','reasoning'],pricing:{prompt:'0.00000015',completion:'0.00000060'}};
test('closed pilot rejects obsolete Groq metadata after the reviewed runtime moves to Cerebras',()=>{assert.throws(()=>reservationEnvelope(ossEndpoint,ossModel));assert.throws(()=>requireZdrEndpoint(ossEndpoint,ossModel,[{...ossEndpoint,safety_retention:false}]));});

test('older NVIDIA envelope remains valid while obsolete local DeepInfra latest-Super route fails closed',()=>{
 for(const [model,tag,prompt,completion,maxout,expected] of [['nvidia/nemotron-3.5-super-vl','deepinfra/fp4',.15,.5,235929,.157287],['nvidia/nemotron-3-super-120b-a12b','deepinfra/bf16',.075,.4,16384,.026215]]){
 const e={model_id:model,tag,provider_name:'DeepInfra',service_tier:null,context_length:262144,max_completion_tokens:maxout,supported_parameters:['max_tokens','response_format','structured_outputs','reasoning'],pricing:{prompt:String(prompt/1e6),completion:String(completion/1e6)}};
 if(model==='nvidia/nemotron-3.5-super-vl'){assert.throws(()=>reservationEnvelope(e,model));assert.throws(()=>requireZdrEndpoint(e,model,[{...e,safety_retention:false}]));continue;}
 assert.equal(reservationEnvelope(e,model).reservationUsd,expected);assert.equal(requireZdrEndpoint(e,model,[{...e,safety_retention:false}]),true);assert.throws(()=>requireZdrEndpoint(e,model,[{...e,safety_retention:true}]));assert.throws(()=>reservationEnvelope({...e,tag:'deepinfra/fp8'},model));
 }
});
