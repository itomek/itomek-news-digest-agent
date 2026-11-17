import test from 'node:test';import assert from 'node:assert/strict';
import {executeCanary} from './canary.mjs';
import {buildReviewRequest} from '../../supabase/functions/news-agent/evaluation.mjs';
import {requestProfileForModel} from '../../supabase/functions/news-agent/model-profiles.mjs';
const model='anthropic/claude-haiku-5.5';
const cases=[{id:'a',sourceUrl:'https://example.com/a',discoveryText:'Synthetic canary.',expectedAction:'skip'}];
const request=buildReviewRequest(cases,{model,allowedModels:[model],maxOutputTokens:100,requestProfile:requestProfileForModel(model)});
function fixture(){const events=[];return {events,ledger:{markDispatched:()=>events.push('dispatch'),settle:(_id,v)=>events.push(v.outcome),markUncertain:()=>events.push('uncertain'),snapshot:()=>({attemptCount:1})},fetcher:async()=>Response.json({id:'synthetic-generation',model,provider:'Anthropic',usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:0.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:[{id:'a',action:'skip',reason:'Synthetic'}]})}}]})};}
const args=f=>({request,model,apiKey:'synthetic-test-only',expectedProvider:'Anthropic',maxCostCredits:1.32,attempt:'synthetic-attempt',cases,save:async()=>{},...f});
test('canary settles exact known usage and captures provider without publishing',async()=>{const f=fixture();const r=await executeCanary(args(f));assert.deepEqual(f.events,['dispatch','success']);assert.equal(r.provider,'Anthropic');assert.equal(r.modelQualityProven,false);});
test('report failure after success retains known settlement and never marks uncertainty',async()=>{const f=fixture();await assert.rejects(()=>executeCanary({...args(f),save:async()=>{throw Error('private write error');}}),e=>e.pilotCode==='canary_report_failed_after_settlement'&&!e.message.includes('private'));assert.deepEqual(f.events,['dispatch','success']);});
test('unknown model outcome retains its hold and never retries',async()=>{const f=fixture();let calls=0;await assert.rejects(()=>executeCanary({...args(f),fetcher:async()=>{calls++;throw Error('private transport error');}}),e=>e.pilotCode==='canary_failed_no_retry');assert.deepEqual(f.events,['dispatch','uncertain']);assert.equal(calls,1);});
test('HTTP failure report retains safe diagnostics but never the raw server message',async()=>{
 const f=fixture();let report;
 await assert.rejects(()=>executeCanary({...args(f),save:async(_name,data)=>{report=data;},fetcher:async()=>Response.json({error:{code:400,type:'invalid_request_error',message:'private-provider-message'}},{status:400})}),e=>e.pilotCode==='canary_failed_no_retry');
 assert.equal(report.httpStatus,400);assert.equal(report.providerErrorCode,400);assert.equal(report.providerErrorType,'invalid_request_error');
 assert.equal(JSON.stringify(report).includes('private-provider-message'),false);assert.deepEqual(f.events,['dispatch','uncertain']);
});
test('invalid decision report retains precise issue and audited identity with known settlement',async()=>{
 const f=fixture();let report;
 const data=await (await f.fetcher()).json();data.choices[0].message.content=JSON.stringify({decisions:[{id:'wrong',action:'skip',reason:'private-model-reason'}]});
 await assert.rejects(()=>executeCanary({...args(f),save:async(_name,data)=>{report=data;},fetcher:async()=>Response.json(data)}),e=>e.pilotCode==='canary_failed_no_retry');
 assert.equal(report.validationIssue,'unknown_id');assert.equal(report.decisionIndex,0);
 assert.deepEqual(report.completionAudit,{model,generationId:'synthetic-generation',provider:'Anthropic'});
 assert.equal(JSON.stringify(report).includes('private-model-reason'),false);assert.deepEqual(f.events,['dispatch','failure']);
});
test('both NVIDIA trials dispatch the same neutral eight IDs once with a 30s timeout and keyed decoding',async()=>{
 const {selectDevelopmentBatch}=await import('./batches.mjs');
 const trialCases=selectDevelopmentBatch(cases.concat(Array(7).fill(cases[0])),'scope-challenge');
 for(const trialModel of ['nvidia/nemotron-3.5-super-vl','nvidia/nemotron-3-super-120b-a12b']){
 const f=fixture();let calls=0;
 const trialRequest=buildReviewRequest(trialCases,{model:trialModel,allowedModels:[trialModel],maxOutputTokens:2048,requestProfile:requestProfileForModel(trialModel)});
 const result=await executeCanary({...args(f),request:trialRequest,model:trialModel,cases:trialCases,expectedProvider:'DeepInfra',maxCostCredits:trialModel.includes('3.5')?.157287:.026215,fetcher:async(_url,options)=>{
 calls++;assert.ok(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);
 const sent=JSON.parse(options.body);assert.equal(sent.max_tokens,2048);assert.deepEqual(sent.reasoning,{effort:'none'});assert.equal(sent.provider.allow_fallbacks,false);
 return Response.json({id:'synthetic-nvidia-generation',model:trialModel,provider:'DeepInfra',usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300,cost:.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:Object.fromEntries([...trialCases].reverse().map(c=>[c.id,trialModel.includes('3.5')?{rating:'skip',reason:'Synthetic fixture decision'}:{action:'skip',reason:'Synthetic fixture decision',importance:0,relevance:0}]))})}}]});
 }});
 assert.equal(calls,1);assert.deepEqual(result.decisions.map(d=>d.id),trialCases.map(c=>c.id));assert.deepEqual(f.events,['dispatch','success']);assert.equal(result.modelQualityProven,false);
 }
});
