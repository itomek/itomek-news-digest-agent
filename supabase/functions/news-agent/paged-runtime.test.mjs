import test from 'node:test';
import assert from 'node:assert/strict';
import {newPagedShadowRun,runPagedShadowInvocation} from './paged-runtime.mjs';
const runId='00000000-0000-4000-8000-000000000001';
const config={enabled:true,model:'test/model',allowedModels:['test/model'],maxOutputTokens:100,maxCostCredits:0.1,apiKey:'test-only',timeoutMs:100};
const candidate=i=>({id:i.toString(16).padStart(64,'0'),sourceUrl:'https://example.com/release',discoveryText:`Release ${i}`});
function fixture({count=3,badDecision=false,unknownCost=false,delayOp,invalidOp,denialReason,configMismatch=false,textSize=0}={}){
 let state=newPagedShadowRun({runId,scanStartedAt:'2026-11-14T20:00:00Z'}),elapsed=0,hash;
 const candidates=[],decisions=[],events=[],audits=[],bindings=[];
 const next=patch=>(state={...state,...patch,revision:state.revision+1});
 const f={events,candidates,decisions,audits,bindings,get state(){return state;},now:()=>elapsed,fetchPage:async({cursor})=>{events.push('page');const start=cursor?parseInt(cursor,16):0;return Array.from({length:Math.min(100,count-start)},(_,i)=>({...candidate(start+i+1),discoveryText:'Release '+ 'x'.repeat(textSize)}));},
 query:async(sql,args)=>{
  const op=sql.match(/shadow_agent\.(\w+)/)[1];events.push(op);let value;
  if(op==='claim')value='lease';if(op==='load')value=structuredClone(state);
  if(op==='paged_bind_config'){bindings.push(args[2]);value=!configMismatch;}
  if(op==='paged_append'){
   assert.equal(args[2],state.revision);const page=args[3];candidates.push(...page);
   value=next(page.length?{cursor:page.at(-1).id,candidateCount:candidates.length}:{phase:'review'});
  }
  if(op==='paged_preview'){assert.equal(args[2],state.revision);value=candidates.slice(state.reviewedCount,state.reviewedCount+args[3]);}
  if(op==='paged_begin'){
   assert.equal(args[2],state.revision);const batch=candidates.slice(state.reviewedCount,state.reviewedCount+args[3]);
   value={state:next(batch.length?{phase:'reviewing',activeBatch:batch.map(c=>c.id)}:{phase:'complete'}),batch};
  }
  if(op==='paged_reserve'){assert.equal(args[2],state.revision);hash=args[3];value=denialReason?{status:'deferred',reason:denialReason,state:next({phase:'review',activeBatch:null})}:{status:'reserved',attemptId:'attempt'};}
  if(op==='dispatch')value=true;
  if(op==='paged_settle'){events.push(args[2]);audits.push(args[4]);value=true;}
  if(op==='paged_commit'){assert.equal(args[2],state.revision);decisions.push(...args[3]);value=next({phase:'review',activeBatch:null,reviewedCount:decisions.length});}
  if(op==='paged_uncertain')value=next({phase:'uncertain'});
  if(op===delayOp)elapsed+=60000;
  return {rows:[{value:op===invalidOp?null:structuredClone(value)}]};
 },fetcher:async(_url,{body})=>{
  events.push('http');assert.equal(hash,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex'));
  if(unknownCost)throw Error('private failure');
  const batch=JSON.parse(JSON.parse(body).messages[1].content).candidates;
  return Response.json({id:'generation',model:'test/model',usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:0.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:badDecision?[]:batch.map(c=>({id:c.id,action:'verify',reason:'Capability'}))})}}]});
 }};return f;
}
test('compact seed and disabled invocation contain no candidate backlog or side effects',async()=>{
 const seed=newPagedShadowRun({runId,scanStartedAt:'2026-11-14T20:00:00Z'});
 assert.equal(seed.storageKind,'paged-v1');assert.equal(seed.candidateCount,0);assert.equal(seed.reviewedCount,0);assert.equal(seed.candidates,undefined);
 assert.deepEqual(await runPagedShadowInvocation({query:()=>assert.fail()}),{status:'disabled',publishingEnabled:false,modelQualityProven:false});
});
test('405 same-source candidates resume by page then review every candidate with bounded batches',async()=>{
 const f=fixture({count:405});let invocations=0;
 while(f.state.phase!=='complete'){
  const result=await runPagedShadowInvocation({runId,config,...f},{pageSteps:2,reviewBatchSize:100});
  assert.equal(result.status,'advanced');assert.equal(result.state.candidates,undefined);assert.equal(result.state.decisions,undefined);
  assert.ok(++invocations<20);
 }
 assert.equal(f.events.filter(e=>e==='page').length,6);assert.equal(f.decisions.length,405);assert.equal(f.decisions.at(-1).id,candidate(405).id);
 assert.equal(f.events.filter(e=>e==='http').length,5);assert.equal(f.state.reviewedCount,405);
});
test('empty scan completes without model calls or filler',async()=>{
 const f=fixture({count:0});await runPagedShadowInvocation({runId,config,...f});await runPagedShadowInvocation({runId,config,...f});
 assert.equal(f.state.phase,'complete');assert.equal(f.events.includes('paged_reserve'),false);assert.equal(f.events.includes('http'),false);
});
test('known malformed completion settles but unknown cost retains uncertain hold and neither replays',async()=>{
 for(const options of [{badDecision:true},{unknownCost:true}]){
  const f=fixture(options);await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
  await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.state.phase,'uncertain');
  assert.ok(f.events.includes(options.badDecision?'settled':'uncertain'));
  await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.events.filter(x=>x==='http').length,1);
 }
});
test('slow reserve or dispatch stops HTTP and preserves uncertainty',async()=>{
 for(const delayOp of ['paged_reserve','dispatch']){
  const f=fixture({delayOp});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
  await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.events.includes('http'),false);assert.equal(f.state.phase,'uncertain');
 }
});
test('invalid bounds and compact state fail closed',async()=>{
 for(const options of [{pageSteps:0},{reviewBatchSize:101}]){
  const f=fixture();await assert.rejects(runPagedShadowInvocation({runId,config,...f},options));assert.equal(f.events.length,0);
 }
 const f=fixture();f.state.candidates=[];await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.events.includes('page'),false);
});
test('unconfirmed append and begin never continue',async()=>{
 const f=fixture({invalidOp:'paged_append'});await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.events.includes('http'),false);
 const g=fixture({invalidOp:'paged_begin'});await runPagedShadowInvocation({runId,config,...g},{pageSteps:2});
 await assert.rejects(runPagedShadowInvocation({runId,config,...g}));assert.equal(g.events.includes('paged_reserve'),false);
});
test('crash after frozen batch blocks resumed dispatch without automatic replay',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
 const base=f.query;
 const query=async(sql,args)=>{const value=await base(sql,args);if(sql.includes('.paged_begin('))throw Error('response lost');return value;};
 await assert.rejects(runPagedShadowInvocation({runId,config,...f,query}));assert.equal(f.state.phase,'reviewing');
 await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(f.events.includes('http'),false);
});
test('unconfirmed reserve, dispatch, settlement or commit stops without replaying HTTP',async()=>{
 for(const invalidOp of ['paged_reserve','dispatch','paged_settle','paged_commit']){
  const f=fixture({invalidOp});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
  await assert.rejects(runPagedShadowInvocation({runId,config,...f}));
  assert.equal(f.events.filter(x=>x==='http').length,['paged_settle','paged_commit'].includes(invalidOp)?1:0);
  await assert.rejects(runPagedShadowInvocation({runId,config,...f}));
 }
});
test('invalid batch identity and altered checkpoint cannot reach reservation',async()=>{
 for(const change of ['id','identity','count','revision']){
  const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});const base=f.query;
  const query=async(sql,args)=>{
   const result=await base(sql,args);
   if(sql.includes('.paged_begin(')){
    if(change==='id')result.rows[0].value.batch[0].id=candidate(99).id;
    if(change==='identity')result.rows[0].value.state.scanStartedAt='2020-01-01';
    if(change==='count')result.rows[0].value.state.candidateCount++;
    if(change==='revision')result.rows[0].value.state.revision++;
   }
   return result;
  };
  await assert.rejects(runPagedShadowInvocation({runId,config,...f,query}));assert.equal(f.events.includes('paged_reserve'),false);
 }
});
test('terminal complete restart has no page, model or checkpoint side effects',async()=>{
 const f=fixture({count:0});await runPagedShadowInvocation({runId,config,...f});await runPagedShadowInvocation({runId,config,...f});
 f.events.length=0;const result=await runPagedShadowInvocation({runId,config,...f});
 assert.equal(result.state.phase,'complete');assert.deepEqual(f.events,['claim','load','paged_bind_config']);
});
test('provider decision order is normalized to frozen candidate order',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
 const fetcher=async(...args)=>{const response=await f.fetcher(...args),data=await response.json();const parsed=JSON.parse(data.choices[0].message.content);parsed.decisions.reverse();data.choices[0].message.content=JSON.stringify(parsed);return Response.json(data);};
 await runPagedShadowInvocation({runId,config,...f,fetcher});assert.deepEqual(f.decisions.map(d=>d.id),[1,2,3].map(i=>candidate(i).id));
});
test('late completion settles cost before expired checkpoint fails',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
 const base=f.query;let late=false;
 const fetcher=async(...args)=>{const response=await f.fetcher(...args);late=true;return response;};
 const query=async(sql,args)=>late&&(/\.paged_(commit|uncertain)\(/.test(sql))?{rows:[{value:null}]}:base(sql,args);
 await assert.rejects(runPagedShadowInvocation({runId,config,...f,fetcher,query}));assert.ok(f.events.includes('settled'));assert.equal(f.state.phase,'reviewing');
});

test('known budget, missing budget or breaker denial defers safely and can resume without billing',async()=>{
 for(const denialReason of ['insufficient_budget','missing_daily_budget','spending_blocked']){
  const f=fixture({denialReason});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
  const result=await runPagedShadowInvocation({runId,config,...f});
  assert.equal(result.status,'deferred');assert.equal(result.reason,denialReason);assert.equal(result.state.phase,'review');assert.equal(result.state.activeBatch,null);assert.equal(result.state.reviewedCount,0);
  assert.equal(f.events.includes('dispatch'),false);assert.equal(f.events.includes('http'),false);assert.equal(f.events.includes('paged_uncertain'),false);
  const base=f.query;
  const query=async(sql,args)=>sql.includes('.paged_reserve(')?{rows:[{value:{status:'reserved',attemptId:'attempt'}}]}:base(sql,args);
  // Resume still uses a real request hash from the denied reservation.
  const resumed=await runPagedShadowInvocation({runId,config,...f,query});assert.equal(resumed.status,'advanced');assert.equal(f.decisions.length,3);
 }
});
test('immutable narrow configuration binds defaults but excludes API key and caller fields',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config:{...config,other:'ignore'},...f});
 assert.deepEqual(f.bindings[0],{model:config.model,maxOutputTokens:100,maxCostCredits:0.1,timeoutMs:100,maxResponseBytes:200000,reviewBatchSize:25,policyVersion:f.state.policyVersion,routing:'openrouter-no-fallback'});
 const g=fixture({configMismatch:true});await assert.rejects(runPagedShadowInvocation({runId,config,...g}));assert.equal(g.events.includes('page'),false);
});
test('success and known or unknown failures persist only bounded model audit metadata',async()=>{
 for(const options of [{},{badDecision:true},{unknownCost:true}]){
  const f=fixture(options);await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
  if(options.badDecision||options.unknownCost)await assert.rejects(runPagedShadowInvocation({runId,config,...f}));else await runPagedShadowInvocation({runId,config,...f});
  assert.equal(f.audits.length,1);assert.equal(JSON.stringify(f.audits).includes('test-only'),false);assert.equal(JSON.stringify(f.audits).includes('private failure'),false);
  if(options.unknownCost)assert.deepEqual(f.audits[0],{errorCode:'transport_failure'});
  else if(options.badDecision){assert.equal(f.audits[0].errorCode,'incomplete_decisions');assert.equal(f.audits[0].usage.costCredits,0.01);}
  else {assert.equal(f.audits[0].model,'test/model');assert.equal(f.audits[0].generationId,'generation');assert.equal(f.audits[0].usage.totalTokens,5);}
 }
});

test('requested 100-candidate batches shrink by exact request bytes and eventually review every candidate',async()=>{
 const f=fixture({count:105,textSize:6000});let invocations=0;
 while(f.state.phase!=='complete'){
  await runPagedShadowInvocation({runId,config,...f},{pageSteps:2,reviewBatchSize:100});assert.ok(++invocations<20);
 }
 assert.equal(f.decisions.length,105);assert.ok(f.events.filter(x=>x==='http').length>2);
 assert.equal(f.events.includes('paged_uncertain'),false);
});
test('single oversized candidate defers before freeze or reservation and remains unreviewed',async()=>{
 const f=fixture({count:1,textSize:200000});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
 const revision=f.state.revision;
 const result=await runPagedShadowInvocation({runId,config,...f},{reviewBatchSize:100});
 assert.equal(result.status,'deferred');assert.equal(result.reason,'candidate_request_too_large');assert.equal(f.state.phase,'review');assert.equal(f.state.revision,revision);assert.equal(f.state.reviewedCount,0);
 assert.equal(f.events.includes('paged_begin'),false);assert.equal(f.events.includes('paged_reserve'),false);assert.equal(f.events.includes('http'),false);
});
test('frozen batch must match exact preview prefix including candidate content',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});const base=f.query;
 const query=async(sql,args)=>{const result=await base(sql,args);if(sql.includes('.paged_begin('))result.rows[0].value.batch[0].discoveryText='Changed after preview';return result;};
 await assert.rejects(runPagedShadowInvocation({runId,config,...f,query}));assert.equal(f.events.includes('paged_reserve'),false);assert.equal(f.events.includes('http'),false);
});
test('stale or empty nonterminal preview fails without freezing a batch',async()=>{
 for(const value of [null,[]]){
  const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});const base=f.query;
  const query=async(sql,args)=>sql.includes('.paged_preview(')?{rows:[{value}]}:base(sql,args);
  // A nonterminal run must preview at least its next candidate.
  await assert.rejects(runPagedShadowInvocation({runId,config,...f,query}));
  assert.equal(f.events.includes('http'),false);
 }
});
test('researched model profile is derived server-side, bound immutably and hashes pinned HTTP bytes',async()=>{
 const f=fixture({count:1}),model='anthropic/claude-haiku-5.5';let body;
 const fetcher=async(...args)=>{body=JSON.parse(args[1].body);const response=await f.fetcher(...args);return Response.json({...await response.json(),model});};
 const cfg={...config,model,allowedModels:[model],requireModelProfile:true,requestProfile:{secret:'must-not-be-bound'}};
 await runPagedShadowInvocation({runId,config:cfg,...f,fetcher},{pageSteps:2});
 assert.equal(f.bindings[0].requestProfile.version,'2026-11-15.2');assert.equal(JSON.stringify(f.bindings).includes('must-not-be-bound'),false);
 await runPagedShadowInvocation({runId,config:cfg,...f,fetcher});
 assert.deepEqual(body.provider.only,['anthropic']);assert.deepEqual(body.provider.order,['anthropic']);assert.equal(body.provider.max_price.request,0);
 assert.equal(Object.hasOwn(body,'temperature'),false);assert.equal(body.response_format.type,'json_schema');
 assert.deepEqual(f.bindings[0].requestProfile,f.bindings[1].requestProfile);
});
test('hosted profile requirement refuses unknown models before database or model work',async()=>{
 const f=fixture();await assert.rejects(()=>runPagedShadowInvocation({runId,config:{...config,requireModelProfile:true},...f}));assert.equal(f.events.length,0);
});
test('explicit generic invocation controls bind immutably while all candidates continue across batches',async()=>{
 const f=fixture({count:9}),cfg={...config,timeoutMs:30000,leaseSeconds:120,maxOutputTokens:2048};
 const batches=[];
 const fetcher=async(...args)=>{const body=JSON.parse(args[1].body);batches.push(JSON.parse(body.messages[1].content).candidates.length);assert.equal(body.max_tokens,2048);return f.fetcher(...args);};
 while(f.state.phase!=='complete')await runPagedShadowInvocation({runId,config:cfg,...f,fetcher},{pageSteps:1,reviewBatchSize:4});
 assert.deepEqual(batches,[4,4,1]);assert.equal(f.decisions.length,9);
 for(const binding of f.bindings){assert.equal(binding.timeoutMs,30000);assert.equal(binding.maxOutputTokens,2048);assert.equal(binding.reviewBatchSize,4);assert.equal(Object.hasOwn(binding,'expectedProvider'),false);}
});
test('new researched profile freezes expected provider and preserves known cost when caller attempts mismatch',async()=>{
 const f=fixture({count:1}),model='google/gemma-4-31b-it';
 const cfg={...config,model,allowedModels:[model],expectedProvider:'Wrong Provider',requestProfile:{provider:{zdr:false,only:['other']}}};
 await runPagedShadowInvocation({runId,config:cfg,...f},{pageSteps:2});
 const fetcher=async(...args)=>{cfg.expectedProvider='Other Provider';const response=await f.fetcher(...args);return Response.json({...await response.json(),model,provider:'Other Provider'});};
 await assert.rejects(runPagedShadowInvocation({runId,config:cfg,...f,fetcher}));
 assert.equal(f.bindings[1].expectedProvider,'DeepInfra');assert.equal(f.bindings[1].requestProfile.provider.zdr,true);
 assert.deepEqual(f.audits[0],{usage:{promptTokens:2,completionTokens:3,totalTokens:5,costCredits:0.01},errorCode:'invalid_completion'});assert.equal(f.state.phase,'uncertain');assert.equal(f.decisions.length,0);assert.ok(f.events.includes('settled'));
});
test('new researched provider is persisted on successful audit and cannot be weakened by caller metadata',async()=>{
 const f=fixture({count:1}),model='google/gemma-4-31b-it',cfg={...config,model,allowedModels:[model],expectedProvider:'Wrong Provider'};
 await runPagedShadowInvocation({runId,config:cfg,...f},{pageSteps:2,reviewBatchSize:4});
 const fetcher=async(...args)=>{const response=await f.fetcher(...args);return Response.json({...await response.json(),model,provider:'DeepInfra'});};
 await runPagedShadowInvocation({runId,config:cfg,...f,fetcher},{reviewBatchSize:4});
 assert.equal(f.decisions.length,1);assert.equal(f.audits[0].provider,'DeepInfra');assert.equal(f.bindings[0].expectedProvider,'DeepInfra');assert.equal(f.bindings[1].reviewBatchSize,4);
});
test('optional successful lease release follows durable checkpoint and defaults off',async()=>{
 for(const enabled of [false,true]){const f=fixture();await runPagedShadowInvocation({runId,config,...f},{releaseLeaseOnSuccess:enabled});assert.equal(f.events.includes('release'),enabled);if(enabled)assert.ok(f.events.indexOf('release')>f.events.indexOf('paged_append'));}
});
test('release is attempted after safe budget deferral but never after uncertain model attempt',async()=>{
 const f=fixture({denialReason:'insufficient_budget'});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});await runPagedShadowInvocation({runId,config,...f},{releaseLeaseOnSuccess:true});assert.equal(f.events.at(-1),'release');assert.equal(f.events.includes('http'),false);
 const g=fixture({unknownCost:true});await runPagedShadowInvocation({runId,config,...g},{pageSteps:2});await assert.rejects(runPagedShadowInvocation({runId,config,...g},{releaseLeaseOnSuccess:true}));assert.equal(g.events.includes('release'),false);
});
test('unknown release result preserves confirmed checkpoint without replaying inference',async()=>{
 const f=fixture();await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});const original=f.query;f.query=async(sql,args)=>{if(sql.includes('.release('))throw Error('unknown release response');return original(sql,args);};
 const out=await runPagedShadowInvocation({runId,config,...f},{releaseLeaseOnSuccess:true});assert.equal(out.status,'advanced');assert.equal(out.state.reviewedCount,3);assert.equal(f.events.filter(x=>x==='http').length,1);
});
test('paid decision failures retain bounded generation and validation coordinates without response text',async()=>{
 const f=fixture({count:1});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});
 const fetcher=async(...args)=>{const p=await(await f.fetcher(...args)).json();p.choices[0].message.content=JSON.stringify({decisions:[{id:candidate(1).id,action:'publish',reason:'private response text'}]});return Response.json(p);};
 await assert.rejects(runPagedShadowInvocation({runId,config,...f,fetcher}));assert.deepEqual(f.audits[0].diagnostic,{generationId:'generation',model:'test/model',validationIssue:'invalid_action',decisionIndex:0});assert.equal(JSON.stringify(f.audits).includes('private response text'),false);assert.equal(f.audits[0].usage.costCredits,.01);
});
test('HTTP refusal status survives paged uncertainty without exposing response or retrying',async()=>{
 for(const status of [400,402,429,500,503]){const f=fixture({count:1});await runPagedShadowInvocation({runId,config,...f},{pageSteps:2});let calls=0;await assert.rejects(runPagedShadowInvocation({runId,config,...f,fetcher:async()=>{calls++;return new Response('secret '+config.apiKey,{status});}}));assert.deepEqual(f.audits[0],{errorCode:'http_failure',diagnostic:{httpStatus:status}});assert.equal(calls,1);assert.equal(f.state.phase,'uncertain');await assert.rejects(runPagedShadowInvocation({runId,config,...f}));assert.equal(calls,1);}
});
