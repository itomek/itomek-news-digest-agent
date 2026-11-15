import test from 'node:test';import assert from 'node:assert/strict';
import {requestProfileForModel} from './model-profiles.mjs';
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
