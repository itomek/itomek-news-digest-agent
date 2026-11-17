import test from 'node:test';import assert from 'node:assert/strict';
import {createAgentService} from './services.mjs';
const projectUrl='https://fixture.supabase.co',serviceKey='synthetic-service-key',run='00000000-0000-4000-8000-000000000111';
test('disabled service performs no database or model network calls',async()=>{
 let calls=0;const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:false}},async()=>{calls++;throw Error();});
 assert.equal(await service.selectRun(),null);assert.equal((await service.runInvocation(run)).status,'disabled');assert.equal(calls,0);
});
test('server-owned selector calls one pinned RPC and refuses redirected or untrusted origin',async()=>{
 assert.throws(()=>createAgentService({projectUrl:'https://evil.example',serviceKey,runtimeConfig:{enabled:true}}));
 let calls=0;const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async(url,opts)=>{
  calls++;assert.equal(String(url),'https://fixture.supabase.co/rest/v1/rpc/warpcore_shadow_select_run');assert.equal(opts.redirect,'error');assert.equal(opts.method,'POST');assert.deepEqual(JSON.parse(opts.body),{});assert.equal(opts.headers.Authorization,`Bearer ${serviceKey}`);return Response.json(run);
 });assert.equal(await service.selectRun(),run);assert.equal(calls,1);
});
test('database failures are bounded and sanitized',async()=>{
 const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>new Response(serviceKey,{status:500}));
 await assert.rejects(()=>service.selectRun(),e=>!e.message.includes(serviceKey));
 const huge=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>new Response('x'.repeat(2100000)));
 await assert.rejects(()=>huge.selectRun());
});
test('invalid selector identity fails before any model transport',async()=>{
 const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>Response.json({model:'caller-model'}));await assert.rejects(()=>service.selectRun());
});
test('service freezes explicit generic invocation and transport controls before caller mutation',async()=>{
 const {newPagedShadowRun}=await import('./paged-runtime.mjs');
 const candidates=[1,2].map(i=>({id:i.toString(16).padStart(64,'0'),sourceUrl:'https://example.com/story',discoveryText:'Synthetic discovery'}));
 let state={...newPagedShadowRun({runId:run,scanStartedAt:'2026-11-14T20:00:00Z'}),phase:'review',candidateCount:2,cursor:candidates[1].id},binding,previewSize;
 const cfg={projectUrl,serviceKey,runtimeConfig:{enabled:true,model:'test/model',allowedModels:['test/model'],maxOutputTokens:2048,maxCostCredits:0.1,apiKey:'synthetic-model-key',timeoutMs:30000,leaseSeconds:120},invocationOptions:{pageSteps:1,reviewBatchSize:2}};
 const service=createAgentService(cfg,async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url)==='https://openrouter.ai/api/v1/chat/completions')return Response.json({id:'synthetic-generation',model:'test/model',usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:0.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:candidates.map(c=>({id:c.id,action:'skip',reason:'Synthetic fixture'}))})}}]});
  const op=String(url).split('warpcore_shadow_')[1];
  if(op==='claim'){assert.equal(body.p_seconds,120);return Response.json('lease');}
  if(op==='load')return Response.json(state);
  if(op==='paged_bind_config'){binding=body.p_config;return Response.json(true);}
  if(op==='paged_preview'){previewSize=body.p_size;return Response.json(candidates);}
  if(op==='paged_begin'){assert.equal(body.p_size,2);state={...state,phase:'reviewing',activeBatch:candidates.map(c=>c.id),revision:state.revision+1};return Response.json({state,batch:candidates});}
  if(op==='paged_reserve')return Response.json({status:'reserved',attemptId:'attempt'});
  if(op==='dispatch'||op==='paged_settle')return Response.json(true);
  if(op==='paged_commit'){state={...state,phase:'review',activeBatch:null,reviewedCount:2,revision:state.revision+1};return Response.json(state);}
  assert.fail('Unexpected RPC '+op);
 });
 cfg.invocationOptions.reviewBatchSize=100;cfg.runtimeConfig.timeoutMs=1;cfg.runtimeConfig.model='mutated/model';
 const result=await service.runInvocation(run);assert.equal(result.state.reviewedCount,2);assert.equal(previewSize,2);
 assert.equal(binding.timeoutMs,30000);assert.equal(binding.maxOutputTokens,2048);assert.equal(binding.reviewBatchSize,2);
});
