import test from 'node:test';import assert from 'node:assert/strict';
import {requestProfileForModel} from './model-profiles.mjs';import {approvedRuntimeModel,DEFAULT_RUNTIME_MODEL} from './approved-runtime-models.mjs';
import {buildReviewRequest} from './evaluation.mjs';import {validateRequestProfile,DISCOVERY_RESPONSE_FORMAT} from './review-contract.mjs';
import {reviewWithOpenRouter,sanitizedHttpDiagnostics} from './openrouter.mjs';
import {buildVerificationRequest} from './verification-contract.mjs';import {verifyWithOpenRouter,VERIFICATION_REQUEST_PROFILE_VERSION} from './verification-openrouter.mjs';
const model='meta-llama/llama-4-maverick',profile=()=>requestProfileForModel(model),approved=()=>approvedRuntimeModel(model);
const config=()=>({enabled:true,apiKey:'synthetic-key',allowedModels:[model],expectedProvider:'Parasail',reservation:{id:'fixture-reservation',maxCostCredits:.216269},timeoutMs:100});
const discovery=()=>buildReviewRequest([{id:'candidate-1',discoveryText:'A new inference capability was released.',sourceUrl:'https://ir.amd.com/release'}],{model,allowedModels:[model],maxOutputTokens:4096,requestProfile:profile()});
const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:.001};
const payload=result=>({id:'fixture-maverick',model,provider:'Parasail',usage,choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
async function verification(){const now='2026-11-16T20:00:00Z',body='Published 2026-11-16. A new inference capability was released.',sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');return buildVerificationRequest({storyKey:'a'.repeat(64),evidenceHash:'b'.repeat(64),evidence:[{id:'e1',sourceType:'rss',visibility:'public',url:'https://ir.amd.com/release'}],sources:[{evidenceId:'e1',url:'https://ir.amd.com/release',body,contentSha256:sha,fetchedAt:now}],history:{snapshotHash:'c'.repeat(64),items:[],complete:true},now},{model,maxOutputTokens:4096});}
test('Maverick reviewed reserve and both canonical requests omit reasoning, pin temperature and use existing gateway',async()=>{
 assert.equal(DEFAULT_RUNTIME_MODEL,'openai/gpt-oss-120b');assert.deepEqual(approved(),{model,provider:'Parasail',discoveryProfileVersion:'2026-11-17.7',maxCostCredits:.216269,maxOutputTokens:4096,reviewBatchSize:16});assert.equal(approved().maxCostCredits,Math.ceil((524288*.35/1e6+32768/1e6)*1e6)/1e6);
 assert.equal(Object.hasOwn(validateRequestProfile(profile()),'reasoning'),false);
 const d=discovery(),v=await verification();assert.match(d.messages[0].content,/STAGE-AWARE DISCOVERY/);assert.equal(VERIFICATION_REQUEST_PROFILE_VERSION,'2026-11-17.verify.7');assert.equal(v.response_format.json_schema.name,'primary_evidence_verification_v7');
 for(const [request,adapter,result] of [[d,reviewWithOpenRouter,{decisions:{'candidate-1':{rating:'verify_i2_r3',reason:'New capability.'}}}],[v,verifyWithOpenRouter,{result:{action:'defer',reason:'Needs more evidence.'}}]]){
  assert.equal(Object.hasOwn(request,'reasoning'),false);assert.equal(request.temperature,0);let calls=0;
  const out=await adapter(request,config(),async(url,options)=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');const wire=JSON.parse(options.body);assert.equal(Object.hasOwn(wire,'reasoning'),false);assert.equal(wire.temperature,0);assert.deepEqual(wire.provider,profile().provider);return Response.json(payload(result));});assert.equal(out.provider,'Parasail');assert.equal(out.usage.costCredits,.001);assert.equal(calls,1);
 }
});
test('Maverick cannot acquire reasoning, temperature drift, route/price/fallback changes or arbitrary schemas',async()=>{
 for(const [make,adapter] of [[discovery,reviewWithOpenRouter],[verification,verifyWithOpenRouter]])for(const mutate of [r=>r.reasoning=undefined,r=>r.reasoning=null,r=>r.reasoning={effort:'none'},r=>r.reasoning={effort:'low'},r=>delete r.temperature,r=>r.temperature=.1,r=>r.provider.only=['other'],r=>r.provider.max_price.completion=1.01,r=>r.provider.max_price.prompt=.36,r=>r.provider.allow_fallbacks=true,r=>r.max_tokens=4097,r=>r.response_format=structuredClone(DISCOVERY_RESPONSE_FORMAT)]){
  const request=structuredClone(await make());mutate(request);let calls=0;await assert.rejects(adapter(request,config(),()=>{calls++;throw Error('forbidden');}),e=>e.outcome==='not_started');assert.equal(calls,0);
 }
 for(const mutate of [p=>p.reasoning=undefined,p=>p.reasoning={effort:'none'},p=>p.temperature=undefined,p=>p.temperature=1,p=>p.provider.max_price.completion=2]){const p=structuredClone(profile());mutate(p);assert.throws(()=>validateRequestProfile(p));}
});
test('Maverick wrong-provider, malformed shape and over-reservation usage preserve known billing',async()=>{
 for(const [make,adapter,result] of [[discovery,reviewWithOpenRouter,{decisions:{'candidate-1':{rating:'skip',reason:'Routine.'}}}],[verification,verifyWithOpenRouter,{result:{action:'defer',reason:'Unsupported.'}}]])for(const kind of ['provider','shape','cost']){
  const p=payload(result);if(kind==='provider')p.provider='Together';if(kind==='shape')p.choices[0].message.content='{}';if(kind==='cost')p.usage={...usage,cost:.216270};
  await assert.rejects(adapter(await make(),config(),async()=>Response.json(p)),e=>e.outcome==='uncertain'&&e.usage.costCredits===p.usage.cost);
 }
 assert.deepEqual(sanitizedHttpDiagnostics({errorProvider:'Parasail',providerErrorCode:'engine_overloaded',raw:'never retain'}),{errorProvider:'Parasail',providerErrorCode:'engine_overloaded'});
});
