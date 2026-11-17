import test from 'node:test';import assert from 'node:assert/strict';
import {requestProfileForModel,expectedProviderForModel} from './model-profiles.mjs';
test('research profiles pin one provider and reviewed tier price caps without choosing a default',()=>{
 assert.equal(requestProfileForModel('unknown/model'),undefined);
 for(const [model,provider,prompt,completion] of [['anthropic/claude-haiku-5.5','anthropic',0.5,2.5],['openai/gpt-5.6-luna','openai',0.4,1.8],['google/gemini-3.8-flash','google-ai-studio',0.75,3.75]]){
  const p=requestProfileForModel(model);assert.equal(p.version,'2026-11-15.2');assert.equal(p.responseFormat,'discovery-json-schema-v1');
  assert.deepEqual(p.provider,{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0}});
  assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.provider.only));assert.throws(()=>p.provider.only.push('other'));
 }
});
test('optional reasoning is disabled only for the two nonmandatory-reasoning canaries',()=>{
 for(const model of ['anthropic/claude-haiku-5.5','openai/gpt-5.6-luna']){
  const p=requestProfileForModel(model);assert.equal(p.version,'2026-11-15.2');assert.deepEqual(p.reasoning,{effort:'none'});assert.ok(Object.isFrozen(p.reasoning));
 }
 assert.equal(Object.hasOwn(requestProfileForModel('google/gemini-3.8-flash'),'reasoning'),false);
});
test('Gemma pilot profiles pin exact quantized routes, prices and ZDR with no reasoning',()=>{
 assert.equal(requestProfileForModel('qwen/qwen3.6-35b-a3b'),undefined);assert.equal(requestProfileForModel('deepseek/deepseek-v4-flash-0731'),undefined);
 for(const [model,route,prompt,completion] of [['google/gemma-4-26b-a4b-it','primeintellect/bf16',0.06,0.18],['google/gemma-4-31b-it','deepinfra/fp8',0.20,0.40]]){
  const p=requestProfileForModel(model);
  assert.deepEqual(p,{version:'2026-11-16.1',reasoning:{effort:'none'},responseFormat:'discovery-json-schema-v1',provider:{only:[route],order:[route],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0},zdr:true}});
  assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.provider));assert.ok(Object.isFrozen(p.provider.max_price));assert.ok(Object.isFrozen(p.reasoning));
  assert.throws(()=>{p.provider.zdr=false;});assert.throws(()=>{p.provider.max_price.prompt=100;});
 }
});

test('only new code-owned profiles expose reviewed exact provider display identities',()=>{
 assert.equal(expectedProviderForModel('google/gemma-4-26b-a4b-it'),'PrimeIntellect');assert.equal(expectedProviderForModel('google/gemma-4-31b-it'),'DeepInfra');
 for(const model of ['unknown/model','anthropic/claude-haiku-5.5','openai/gpt-5.6-luna','google/gemini-3.8-flash'])assert.equal(expectedProviderForModel(model),undefined);
});
test('only added candidate is GPT-OSS120B with fixed Groq, low reasoning and new privacy-bound version',()=>{
 const model='openai/gpt-oss-120b',p=requestProfileForModel(model,'2026-11-16.2');
 assert.deepEqual(p,{version:'2026-11-16.2',reasoning:{effort:'low'},responseFormat:'discovery-json-schema-v1',provider:{only:['groq'],order:['groq'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.15,completion:0.60,request:0},zdr:true}});
 assert.equal(expectedProviderForModel(model),'Groq');assert.ok(Object.isFrozen(p.reasoning));assert.ok(Object.isFrozen(p.provider.max_price));assert.throws(()=>{p.reasoning.effort='high';});
 for(const gemma of ['google/gemma-4-26b-a4b-it','google/gemma-4-31b-it']){const old=requestProfileForModel(gemma);assert.equal(old.version,'2026-11-16.1');assert.deepEqual(old.reasoning,{effort:'none'});}
});
test('historical ranked array retains explicit immutable GPT-oss profile',()=>{
 const current=requestProfileForModel('openai/gpt-oss-120b','2026-11-16.3');
 assert.equal(current.version,'2026-11-16.3');
 assert.equal(current.responseFormat,'discovery-ranked-json-schema-v2');
 assert.equal(current.rankingRubricVersion,'2026-11-16.1');
 const old=requestProfileForModel('openai/gpt-oss-120b','2026-11-16.2');
 assert.equal(old.responseFormat,'discovery-json-schema-v1');
 assert.equal(Object.hasOwn(old,'rankingRubricVersion'),false);
 assert.deepEqual(current.provider,old.provider);
 assert.ok(Object.isFrozen(current.provider.max_price));
 assert.equal(requestProfileForModel('openai/gpt-oss-120b','unknown'),undefined);
});
test('keyed default versions only fresh GPT-oss calls and preserves historical ranked array profile',()=>{
 const current=requestProfileForModel('openai/gpt-oss-120b');assert.equal(current.version,'2026-11-16.4');assert.equal(current.responseFormat,'discovery-keyed-ranked-json-schema-v3');
 const old=requestProfileForModel('openai/gpt-oss-120b','2026-11-16.3');assert.equal(old.version,'2026-11-16.3');assert.equal(old.responseFormat,'discovery-ranked-json-schema-v2');assert.deepEqual(current.provider,old.provider);assert.deepEqual(current.reasoning,old.reasoning);assert.equal(current.rankingRubricVersion,old.rankingRubricVersion);
 assert.ok(Object.isFrozen(current));assert.ok(Object.isFrozen(old));
});
test('NVIDIA trial profiles are keyed, private, pinned and do not replace GPT-oss',()=>{
 for(const [model,version,tag,prompt,completion] of [['nvidia/nemotron-3.5-super-vl','2026-11-17.1','deepinfra/fp4',.15,.50],['nvidia/nemotron-3-super-120b-a12b','2026-11-17.2','deepinfra/bf16',.075,.40]]){
 const p=requestProfileForModel(model,version);assert.ok(p);assert.equal(p.version,version);assert.deepEqual(p.reasoning,{effort:'none'});assert.equal(p.responseFormat,'discovery-keyed-ranked-json-schema-v3');assert.equal(p.rankingRubricVersion,'2026-11-16.1');assert.deepEqual(p.provider,{only:[tag],order:[tag],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0},zdr:true});assert.equal(expectedProviderForModel(model,version),'DeepInfra');assert.equal(requestProfileForModel(model,'2026-11-16.4'),undefined);
 }
 assert.equal(requestProfileForModel('openai/gpt-oss-120b').version,'2026-11-16.4');
});
test('only fresh latest NVIDIA uses coded protocol while billed trial profiles retain their formats',()=>{
 const model='nvidia/nemotron-3.5-super-vl',current=requestProfileForModel(model,'2026-11-17.4');
 assert.equal(current.version,'2026-11-17.4');assert.equal(current.responseFormat,'discovery-keyed-coded-ranking-json-schema-v4');
 for(const version of ['2026-11-17.1','2026-11-17.3']){const old=requestProfileForModel(model,version);assert.equal(old.responseFormat,'discovery-keyed-ranked-json-schema-v3');assert.deepEqual(old.provider,current.provider);assert.deepEqual(old.reasoning,current.reasoning);assert.equal(old.rankingRubricVersion,current.rankingRubricVersion);assert.ok(Object.isFrozen(old));}
 assert.ok(Object.isFrozen(current));assert.equal(requestProfileForModel('nvidia/nemotron-3-super-120b-a12b').version,'2026-11-17.2');assert.equal(requestProfileForModel('openai/gpt-oss-120b').version,'2026-11-16.4');
});
test('Together17.5 is an immutable explicit route while all DeepInfra history remains addressable',()=>{
 const model='nvidia/nemotron-3.5-super-vl',p=requestProfileForModel(model);
 assert.equal(p.version,'2026-11-17.5');assert.equal(p.responseFormat,'discovery-keyed-coded-ranking-json-schema-v4');assert.deepEqual(p.reasoning,{effort:'none'});assert.deepEqual(p.provider,{only:['together'],order:['together'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:.15,completion:.50,request:0},zdr:true});assert.equal(expectedProviderForModel(model),'Together');
 for(const version of ['2026-11-17.1','2026-11-17.3','2026-11-17.4']){assert.equal(requestProfileForModel(model,version).provider.only[0],'deepinfra/fp4');assert.equal(expectedProviderForModel(model,version),'DeepInfra');}
 assert.equal(expectedProviderForModel(model,'unknown'),undefined);assert.ok(Object.isFrozen(p.provider.only));
});
test('Together route changes only provider pins and retains exact coded stage-aware prompt',async()=>{
 const {buildReviewRequest}=await import('./evaluation.mjs');const model='nvidia/nemotron-3.5-super-vl',cases=[{id:'neutral',sourceUrl:'https://example.com/',discoveryText:'Public fixture.'}];
 const build=version=>buildReviewRequest(cases,{model,allowedModels:[model],maxOutputTokens:4096,requestProfile:requestProfileForModel(model,version)});
 const old=build('2026-11-17.4'),fresh=build('2026-11-17.5');assert.deepEqual(fresh.messages,old.messages);assert.deepEqual(fresh.response_format,old.response_format);assert.deepEqual(fresh.reasoning,old.reasoning);assert.deepEqual({...fresh,provider:old.provider},old);
});
