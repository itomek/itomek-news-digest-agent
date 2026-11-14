import test from 'node:test';
import assert from 'node:assert/strict';
import {newShadowRun,advanceShadowRun} from './workflow.mjs';
import {buildReviewRequest} from './evaluation.mjs';
import {reviewWithOpenRouter} from './openrouter.mjs';
test('offline workflow/request/transport contract composes without a publisher',async()=>{
 const id='a'.repeat(64);let state=newShadowRun({runId:'offline-integration',scanStartedAt:'2026-11-14T19:00:00Z'}),calls=0;
 const ledger=[];
 const save=async(next,revision)=>{assert.equal(state.revision,revision);state=structuredClone(next);};
 const fetchPage=async({cursor})=>cursor===null?[{id,sourceUrl:'https://example.com/release',sourceType:'rss',discoveryText:'A synthetic release fixture.'}]:[];
 const review=async candidates=>{
  const request=buildReviewRequest(candidates,{model:'test/model',allowedModels:['test/model'],maxOutputTokens:2000});
  // Synthetic reservation and response are not a production budget ledger.
  const result=await reviewWithOpenRouter(request,{enabled:true,apiKey:'offline-only',allowedModels:['test/model'],reservation:{id:'offline-reservation',maxCostCredits:1}},async(url,options)=>{
   calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(state.phase,'reviewing');
   assert.equal(JSON.parse(options.body).provider.allow_fallbacks,false);
   return Response.json({id:'synthetic-generation',model:'test/model',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:candidates.map(c=>({id:c.id,action:'verify',reason:'Needs source evidence'}))})}}]});
  });
  ledger.push(result.usage);return result.decisions;
 };
 while(state.phase!=='complete')await advanceShadowRun(state,{save,fetchPage,review});
 assert.equal(calls,1);assert.equal(ledger[0].costCredits,0.001);assert.equal(state.decisions.length,1);assert.equal(state.publishingEnabled,false);
});
