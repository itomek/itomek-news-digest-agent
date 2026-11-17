import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildSmokePlan} from './paid-smoke-prepare.mjs';
const runId='00000000-0000-4000-8000-000000000777',model='google/gemma-4-31b-it';
const cases=Array.from({length:8},(_,i)=>({sourceUrl:'https://example.com/'+i,sourceType:'rss',sourceCreatedAt:'2026-11-14',discoveryText:'Public discovery '+i,expectedAction:'skip',ownerRationale:'GOLD'}));
test('prepared four-case request is sorted, exact hashed and free of gold/credentials',()=>{
 const plan=buildSmokePlan({runId,model,reservationUsd:0.058983,cases});
 assert.equal(plan.candidates.length,4);assert.deepEqual(plan.candidates.map(c=>c.id),plan.candidates.map(c=>c.id).sort());
 assert.equal(plan.requestHash,createHash('sha256').update(plan.requestBody).digest('hex'));
 assert.equal(plan.requestBody.includes('GOLD'),false);assert.equal(plan.requestBody.includes('expectedAction'),false);
 assert.equal(JSON.parse(plan.requestBody).provider.zdr,true);assert.equal(plan.leaseSeconds,120);assert.equal(plan.timeoutMs,30000);
 assert.throws(()=>buildSmokePlan({runId,model:'fixture/unpinned',reservationUsd:0.1,cases}));
});
test('paid smoke CLI function is importable without side effects',async()=>{
 const module=await import('./paid-smoke.ts');assert.equal(typeof module.runPaidSmoke,'function');
});
const attempt='00000000-0000-4000-8000-000000000888';
const smokeEnv=plan=>({HALO_PAID_RUN_ID:runId,HALO_PAID_MODEL:model,HALO_PAID_REQUEST_HASH:plan.requestHash,HALO_PAID_RESERVATION_USD:String(plan.reservationUsd),HALO_PAID_SERVICE_JWT:'synthetic-service-jwt',OPENROUTER_API_KEY:'synthetic-model-key',HALO_PAID_LEDGER_ATTEMPT_ID:attempt});
async function runtimeFixture(){
 const {runPaidSmoke}=await import('./paid-smoke.ts');
 const {newPagedShadowRun}=await import('../../supabase/functions/news-agent/paged-runtime.mjs');
 const plan=buildSmokePlan({runId,model,reservationUsd:0.058983,cases});
 let state={...newPagedShadowRun({runId,scanStartedAt:'2026-11-16T20:00:00Z'}),revision:2,phase:'review',candidateCount:4,cursor:plan.candidates.at(-1).id};
 const calls=[];let posts=0;
 const fetcher=async(raw,options)=>{
  const url=new URL(raw),body=JSON.parse(options.body);
  if(url.origin==='https://openrouter.ai'){
   posts++;assert.equal(url.href,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.body,plan.requestBody);
   assert.ok(calls.includes('dispatch'));assert.equal(options.headers.Authorization,'Bearer synthetic-model-key');
   return Response.json({id:'fixture-paid-smoke',model,provider:'DeepInfra',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:plan.candidates.map(c=>({id:c.id,action:'skip',reason:'Synthetic fixture'}))})}}]});
  }
  assert.equal(url.origin,'http://postgrest:3000');assert.equal(options.headers.Authorization,'Bearer synthetic-service-jwt');
  const op=url.pathname.split('warpcore_shadow_')[1];calls.push(op);
  switch(op){
   case 'claim':assert.equal(body.p_seconds,120);return Response.json('synthetic-lease');
   case 'load':return Response.json(state);
   case 'paged_bind_config':assert.equal(body.p_config.timeoutMs,30000);assert.equal(body.p_config.expectedProvider,'DeepInfra');return Response.json(true);
   case 'paged_preview':return Response.json(state.reviewedCount===4?[]:plan.candidates);
   case 'paged_begin':{const batch=state.reviewedCount===4?[]:plan.candidates;state={...state,revision:state.revision+1,phase:batch.length?'reviewing':'complete',activeBatch:batch.length?batch.map(c=>c.id):null};return Response.json({state,batch});}
   case 'paged_reserve':return Response.json({status:'reserved',attemptId:attempt});
   case 'dispatch':return Response.json(true);
   case 'paged_settle':assert.equal(body.p_cost,0.001);assert.equal(body.p_audit.provider,'DeepInfra');return Response.json(true);
   case 'paged_commit':assert.equal(body.p_decisions.length,4);state={...state,revision:state.revision+1,phase:'review',activeBatch:null,reviewedCount:4};return Response.json(state);
   case 'paged_uncertain':state={...state,revision:state.revision+1,phase:'uncertain'};return Response.json(state);
   default:assert.fail('Unexpected operation '+op);
  }
 };
 return {plan,calls,fetcher,runPaidSmoke,get posts(){return posts;}};
}
test('one paid-path invocation uses exact approved bytes and private SQL; second completion cannot call model',async()=>{
 const f=await runtimeFixture();
 const response=await f.runPaidSmoke(smokeEnv(f.plan),f.fetcher);assert.equal(response.reviewedCount,4);assert.equal(response.modelPosts,1);assert.equal(f.posts,1);
 const complete=await f.runPaidSmoke(smokeEnv(f.plan),f.fetcher);assert.equal(complete.phase,'complete');assert.equal(complete.modelPosts,0);assert.equal(f.posts,1);
 assert.equal(f.calls.includes('select_run'),false);assert.equal(f.calls.includes('candidate_page'),false);
});
test('hash mismatch fails without sending provider HTTP and invalid plan fails before any network',async()=>{
 const f=await runtimeFixture();await assert.rejects(()=>f.runPaidSmoke({...smokeEnv(f.plan),HALO_PAID_REQUEST_HASH:'f'.repeat(64)},f.fetcher));assert.equal(f.posts,0);assert.ok(f.calls.includes('paged_uncertain'));
 let calls=0;await assert.rejects(()=>f.runPaidSmoke({...smokeEnv(f.plan),HALO_PAID_LEDGER_ATTEMPT_ID:''},async()=>{calls++;throw Error();}));assert.equal(calls,0);
});
