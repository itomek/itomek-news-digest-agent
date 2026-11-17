import {requestProfileForModel} from '../../supabase/functions/news-agent/model-profiles.mjs';
// Public metadata preflight, not a tokenizer or an unconditional billing guarantee.
const fail=()=>{throw Error('Unverified pilot pricing or capability envelope');};
const positive=v=>Number.isFinite(v)&&v>0;
const rateKeys=new Set(['prompt','completion','request','internal_reasoning','input_cache_read','input_cache_write','input_cache_write_1h','web_search','image','image_output','audio','input_audio_cache','discount','overrides']);
const conditionKeys=new Set(['min_prompt_tokens','utc_start','utc_end','utc_days']);
const pilotProviders=Object.freeze({'anthropic/claude-haiku-5.5':'Anthropic','openai/gpt-5.6-luna':'OpenAI','google/gemma-4-26b-a4b-it':'PrimeIntellect','google/gemma-4-31b-it':'DeepInfra'});
export function reservationEnvelope(endpoint,model='anthropic/claude-haiku-5.5'){
 if(typeof model!=='string'||!Object.hasOwn(pilotProviders,model))fail();
 const provider=requestProfileForModel(model)?.provider;
 if(!provider||provider.only.length!==1||provider.allow_fallbacks!==false||provider.require_parameters!==true||provider.max_price.request!==0)fail();
 if(!endpoint||endpoint.tag!==provider.only[0]||endpoint.provider_name!==pilotProviders[model]||(Object.hasOwn(endpoint,'model_id')&&endpoint.model_id!==model)||endpoint.service_tier||!Number.isSafeInteger(endpoint.context_length)||!positive(endpoint.context_length)||endpoint.context_length>10000000||!Number.isSafeInteger(endpoint.max_completion_tokens)||!positive(endpoint.max_completion_tokens)||endpoint.max_completion_tokens>10000000)fail();
 for(const param of ['max_tokens','response_format','structured_outputs','reasoning'])if(!endpoint.supported_parameters?.includes(param))fail();
 const base=endpoint.pricing;if(!base||typeof base!=='object'||Array.isArray(base))fail();
 const variants=[base,...(base.overrides??[]).map(x=>({...base,...x}))];
 let input=0,output=0;
 for(const prices of variants){
  for(const [key,value] of Object.entries(prices)){
   if(conditionKeys.has(key)||key==='overrides')continue;
   if(!rateKeys.has(key))fail();
   const n=Number(value);if(!Number.isFinite(n)||n<0)fail();
  }
  if(Number(prices.request??0)!==0)fail();
  if(!positive(Number(prices.prompt))||!positive(Number(prices.completion)))fail();
  // Unit-price routing caps exclude a more expensive changed endpoint.
  if(Number(prices.prompt)>provider.max_price.prompt/1e6||Number(prices.completion)>provider.max_price.completion/1e6)fail();
  input=Math.max(input,...['prompt','input_cache_read','input_cache_write','input_cache_write_1h'].map(k=>Number(prices[k]??0)));
  output=Math.max(output,Number(prices.completion),Number(prices.internal_reasoning??0));
 }
 // Reserve through the approved routing caps, not only a possibly cheaper
 // metadata snapshot. Token-class surcharges above caps still dominate.
 input=Math.max(input,provider.max_price.prompt/1e6);
 output=Math.max(output,provider.max_price.completion/1e6);
 const reservationUsd=Math.ceil((endpoint.context_length*input+endpoint.max_completion_tokens*output)*1e6)/1e6;
 if(!positive(reservationUsd)||reservationUsd>2)fail();
 return {expectedProvider:endpoint.provider_name,contextTokens:endpoint.context_length,completionTokens:endpoint.max_completion_tokens,maxInputUsdPerToken:input,maxOutputUsdPerToken:output,reservationUsd,basis:'Advertised full context/completion limits and highest applicable token-class rates; text-only request with no tools/plugins/media/request fee'};
}
// Both independently fetched metadata sources must identify the same pinned
// endpoint; the ZDR listing must explicitly exclude safety retention. Pricing comes from the
// model endpoint and routing caps; ZDR listing prices are not compared.
export function requireZdrEndpoint(endpoint,model,zdrRows){
 if(typeof model!=='string'||!Object.hasOwn(pilotProviders,model)||!Array.isArray(zdrRows))fail();
 const provider=requestProfileForModel(model)?.provider;
 if(!provider||!endpoint||endpoint.tag!==provider.only[0]||endpoint.model_id!==model
 ||endpoint.provider_name!==pilotProviders[model]||(Object.hasOwn(endpoint,'safety_retention')&&endpoint.safety_retention!==false)||endpoint.service_tier)fail();
 const matching=zdrRows.filter(row=>row&&row.tag===provider.only[0]&&row.model_id===model&&row.provider_name===pilotProviders[model]);
 if(matching.length!==1||matching[0].safety_retention!==false||matching[0].service_tier)fail();
 return true;
}
export function fundingReady(key,credits,reservationUsd){
 if(!positive(reservationUsd)||key?.is_management_key!==false||key?.is_provisioning_key!==false||key?.is_free_tier!==false)return false;
 if(key.limit_remaining!==null&&(!Number.isFinite(key.limit_remaining)||key.limit_remaining<reservationUsd))return false;
 return Number.isFinite(credits?.total_credits)&&Number.isFinite(credits?.total_usage)&&credits.total_credits>=0&&credits.total_usage>=0&&credits.total_credits-credits.total_usage>=reservationUsd;
}
export function campaignBlockReason(campaign,{requestHash,reservationUsd}){
 if(campaign.blocked)return 'campaign_spending_blocked';
 if(campaign.inFlightAttempts>0)return 'attempt_requires_reconciliation';
 if(campaign.attempts.some(attempt=>attempt.requestHash===requestHash))return 'request_already_attempted';
 if(campaign.attemptCount>=campaign.maxAttempts)return 'campaign_attempt_limit';
 const reservation=BigInt(Math.ceil(reservationUsd*1e6));
 if(BigInt(campaign.spentMicrousd)+BigInt(campaign.heldMicrousd)+reservation>BigInt(campaign.budgetMicrousd))return 'campaign_budget_insufficient';
 return null;
}
