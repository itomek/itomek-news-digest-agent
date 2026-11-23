import test from 'node:test';import assert from 'node:assert/strict';
import {requestProfileForModel,expectedProviderForModel} from './model-profiles.mjs';import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import {buildReviewRequest} from './evaluation.mjs';import {buildVerificationRequest} from './verification-contract.mjs';import {reviewWithOpenRouter} from './openrouter.mjs';import {verifyWithOpenRouter} from './verification-openrouter.mjs';
const model='google/gemma-4-26b-a4b-it';
test('fresh Gemma26 PrimeIntellect route pins current prices and cap while historical profile stays unchanged',()=>{
 const p=requestProfileForModel(model);assert.equal(p.version,'2026-11-17.8');assert.deepEqual(p.reasoning,{effort:'none'});assert.equal(Object.hasOwn(p,'temperature'),false);assert.equal(p.responseFormat,'discovery-keyed-coded-ranking-json-schema-v4');assert.equal(expectedProviderForModel(model),'PrimeIntellect');assert.deepEqual(p.provider,{only:['primeintellect/bf16'],order:['primeintellect/bf16'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:.10,completion:.30,request:0},zdr:true});assert.equal(approvedRuntimeModel(model).maxCostCredits,.036045);assert.equal(.036045,Math.ceil((262144*.10/1e6+32768*.30/1e6)*1e6)/1e6);assert.equal(requestProfileForModel(model,'2026-11-16.1').provider.max_price.prompt,.06);assert.equal(requestProfileForModel(model,'2026-11-16.1').provider.max_price.completion,.18);
});
const cfg=()=>({enabled:true,apiKey:'synthetic-key',allowedModels:[model],expectedProvider:'PrimeIntellect',reservation:{id:'fixture',maxCostCredits:.036045},timeoutMs:100});
const discovery=()=>buildReviewRequest([{id:'c1',discoveryText:'A new inference capability.',sourceUrl:'https://ir.amd.com/release'}],{model,allowedModels:[model],maxOutputTokens:4096,requestProfile:requestProfileForModel(model)});
async function verification(){const now='2026-11-17T13:00:00.000Z',body='Published 2026-11-11. A new inference capability.',sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');return buildVerificationRequest({storyKey:'a'.repeat(64),evidenceHash:'b'.repeat(64),evidence:[{id:'e1',url:'https://ir.amd.com/release',sourceType:'rss',visibility:'public'}],sources:[{evidenceId:'e1',url:'https://ir.amd.com/release',body,contentSha256:sha,fetchedAt:now}],history:{snapshotHash:'c'.repeat(64),items:[],complete:true},now},{model,maxOutputTokens:4096});}
const payload=result=>({id:'fixture-gemma',model,provider:'PrimeIntellect',usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
test('Gemma discovery and V8 verification keep fixed route, none reasoning and known usage',async()=>{
 for(const [make,adapter,result] of [[discovery,reviewWithOpenRouter,{decisions:{c1:{rating:'verify_i2_r3',reason:'New capability.'}}}],[verification,verifyWithOpenRouter,{result:{action:'defer',reason:'Needs verification.'}}]]){const r=await make();assert.deepEqual(r.reasoning,{effort:'none'});assert.equal(Object.hasOwn(r,'temperature'),false);if(make===verification){assert.equal(r.response_format.json_schema.name,'primary_evidence_verification_v8');assert.match(r.messages[0].content,/TRUSTED SERVER CLOCK/);}else assert.match(r.messages[0].content,/STAGE-AWARE DISCOVERY/);const out=await adapter(r,cfg(),async(url,options)=>{assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.deepEqual(JSON.parse(options.body).provider,requestProfileForModel(model).provider);return Response.json(payload(result));});assert.equal(out.provider,'PrimeIntellect');assert.equal(out.usage.costCredits,.001);}
});
test('Gemma refuses control drift before POST and retains billed invalid response costs',async()=>{
 for(const [make,adapter,result] of [[discovery,reviewWithOpenRouter,{decisions:{c1:{rating:'skip',reason:'Routine.'}}}],[verification,verifyWithOpenRouter,{result:{action:'defer',reason:'Unsupported.'}}]]){
 for(const change of [r=>r.reasoning={effort:'low'},r=>r.reasoning=undefined,r=>r.temperature=0,r=>r.provider.max_price.prompt=.11,r=>r.provider.max_price.completion=.31,r=>r.provider.only=['deepinfra/fp8'],r=>r.provider.zdr=false,r=>r.max_tokens=4097]){const r=structuredClone(await make());change(r);let calls=0;await assert.rejects(adapter(r,cfg(),()=>{calls++;throw Error('forbidden');}),e=>e.outcome==='not_started');assert.equal(calls,0);}
 for(const kind of ['provider','shape','cost']){const p=payload(result);if(kind==='provider')p.provider='DeepInfra';if(kind==='shape')p.choices[0].message.content='{}';if(kind==='cost')p.usage.cost=.036046;await assert.rejects(adapter(await make(),cfg(),async()=>Response.json(p)),e=>e.usage.costCredits===p.usage.cost);}
 }
});
test('one-pass headline review uses the pinned route without a stale unit-price filter',async()=>{
 const r=buildReviewRequest([{id:'c1',discoveryText:'A new inference capability.',sourceUrl:'https://ir.amd.com/release'}],{model,allowedModels:[model],maxOutputTokens:4096,requestProfile:requestProfileForModel(model)},{sourceLinkHistory:{snapshotHash:'a'.repeat(64),complete:true,entries:[]}});
 const out=await reviewWithOpenRouter(r,{...cfg(),onePassHeadlines:true},async(_url,{body})=>{
  const actual=JSON.parse(body).provider;
  assert.equal(Object.hasOwn(actual,'max_price'),false);
  assert.deepEqual(actual,{only:['primeintellect/bf16'],order:['primeintellect/bf16'],allow_fallbacks:false,require_parameters:true,zdr:true});
  return Response.json(payload({decisions:{c1:{rating:'verify_i2_r3',reason:'New capability.'}}}));
 });
 assert.equal(out.usage.costCredits,.001);
 assert.equal(r.provider.max_price.completion,.30,'legacy profile and immutable run identity are unchanged');
});
test('unit-price filter cannot be removed from legacy or unapproved requests',async()=>{
 const r=discovery();let calls=0;
 await assert.rejects(()=>reviewWithOpenRouter(r,{...cfg(),onePassHeadlines:true},async()=>{calls++;throw Error('not reached');}),e=>e.code==='unsupported_request'&&e.outcome==='not_started');
 assert.equal(calls,0);
});
