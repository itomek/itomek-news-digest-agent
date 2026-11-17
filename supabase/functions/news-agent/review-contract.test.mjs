import test from 'node:test';import assert from 'node:assert/strict';
import {validateProviderPolicy,validateRequestProfile,validateReasoningControl} from './review-contract.mjs';
import {requestProfileForModel} from './model-profiles.mjs';
import {buildReviewRequest} from './evaluation.mjs';
import {serializeReviewBody} from './openrouter.mjs';
const provider=()=>({only:['primeintellect/bf16'],order:['primeintellect/bf16'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.06,completion:0.18,request:0}});
const profile=()=>({version:'2026-11-16.1',provider:{...provider(),zdr:true},reasoning:{effort:'none'},responseFormat:'discovery-json-schema-v1'});
test('provider policy permits optional ZDR only as exact true and rejects alternate routes/options',()=>{
 assert.deepEqual(validateProviderPolicy(provider()),provider());
 const p={...provider(),zdr:true};const copy=validateProviderPolicy(p);assert.deepEqual(copy,p);copy.only[0]='other';assert.equal(p.only[0],'primeintellect/bf16');
 for(const zdr of [false,null,undefined,'true',1,{},[]])assert.throws(()=>validateProviderPolicy({...provider(),zdr}));
 for(const change of [p=>p.only.push('deepinfra/fp8'),p=>p.order=['other'],p=>p.allow_fallbacks=true,p=>p.require_parameters=false,p=>p.max_price.request=1,p=>p.arbitrary=true]){const p={...provider(),zdr:true};change(p);assert.throws(()=>validateProviderPolicy(p));}
});
test('new profile version requires ZDR while existing profile version retains exact prior policy',()=>{
 assert.deepEqual(validateRequestProfile(profile()),profile());
 const absent=profile();delete absent.provider.zdr;assert.throws(()=>validateRequestProfile(absent));
 const falseZdr=profile();falseZdr.provider.zdr=false;assert.throws(()=>validateRequestProfile(falseZdr));
 for(const model of ['anthropic/claude-haiku-5.5','openai/gpt-5.6-luna','google/gemini-3.8-flash']){
  const p=requestProfileForModel(model);assert.equal(p.version,'2026-11-15.2');assert.equal(Object.hasOwn(p.provider,'zdr'),false);assert.deepEqual(validateRequestProfile(p),p);
 }
 assert.throws(()=>validateRequestProfile({...profile(),version:'2026-11-15.2'}),'Old version cannot silently gain new ZDR policy');
 assert.throws(()=>validateRequestProfile({...profile(),version:'future'}));
});
test('new profiles survive builder and exact HTTP serialization with ZDR and pinned prices intact',()=>{
 for(const model of ['google/gemma-4-26b-a4b-it','google/gemma-4-31b-it']){
  const requestProfile=requestProfileForModel(model);
  const r=buildReviewRequest([{id:'a',sourceUrl:'https://example.com/story',discoveryText:'Public discovery'}],{model,allowedModels:[model],maxOutputTokens:100,requestProfile});
  const body=JSON.parse(serializeReviewBody(r));assert.deepEqual(body.provider,requestProfile.provider);assert.deepEqual(body.reasoning,{effort:'none'});assert.equal(body.response_format.json_schema.strict,true);
 }
});

test('generic reasoning accepts only none or low while profiles keep version-specific reasoning',()=>{
 assert.deepEqual(validateReasoningControl({effort:'none'}),{effort:'none'});assert.deepEqual(validateReasoningControl({effort:'low'}),{effort:'low'});
 for(const reasoning of [{effort:'medium'},{effort:'high'},{effort:'low',exclude:true},{effort:'low',max_tokens:1},{enabled:true},null,{}])assert.throws(()=>validateReasoningControl(reasoning));
 const next={...profile(),version:'2026-11-16.2',reasoning:{effort:'low'}};assert.deepEqual(validateRequestProfile(next),next);
 for(const version of ['2026-11-15.2','2026-11-16.1']){const p=structuredClone(version==='2026-11-15.2'?requestProfileForModel('openai/gpt-5.6-luna'):profile());p.reasoning={effort:'low'};assert.throws(()=>validateRequestProfile(p));}
 for(const reasoning of [undefined,{effort:'none'},{effort:'medium'},{effort:'high'}]){const p={...next,reasoning};if(reasoning===undefined)delete p.reasoning;assert.throws(()=>validateRequestProfile(p));}
 const missingOldReasoning=profile();delete missingOldReasoning.reasoning;assert.throws(()=>validateRequestProfile(missingOldReasoning));
 const missingZdr=structuredClone(next);delete missingZdr.provider.zdr;assert.throws(()=>validateRequestProfile(missingZdr));
});
test('GPT-OSS low reasoning and pinned Groq ZDR policy survive exact request serialization',()=>{
 const model='openai/gpt-oss-120b',requestProfile=requestProfileForModel(model);
 const r=buildReviewRequest([{id:'a',sourceUrl:'https://example.com/story',discoveryText:'Public discovery'}],{model,allowedModels:[model],maxOutputTokens:2048,requestProfile});
 const body=JSON.parse(serializeReviewBody(r));assert.deepEqual(body.provider,requestProfile.provider);assert.deepEqual(body.reasoning,{effort:'low'});assert.equal(body.max_tokens,2048);assert.equal(Object.hasOwn(body,'temperature'),false);
});
