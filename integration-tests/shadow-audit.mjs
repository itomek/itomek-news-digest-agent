// Offline private PostgreSQL contracts, no HTTP or live budgets.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(), q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const candidate={id:'a'.repeat(64),sourceUrl:'https://example.com/a',sourceType:'rss',discoveryText:'Synthetic audit fixture.'};
const config={model:'fixture/offline-model',maxOutputTokens:100,maxCostCredits:0.1,timeoutMs:1000,maxResponseBytes:20000,policyVersion:newPagedShadowRun({runId:randomUUID(),scanStartedAt:'2026-11-14T20:00:00Z'}).policyVersion,routing:'openrouter-no-fallback'};
const usage={promptTokens:10,completionTokens:5,totalTokens:15,costCredits:0.04};
const decision=[{id:candidate.id,action:'skip',reason:'Synthetic decision.'}];
async function fixture(cap=1,boundConfig=config){
 const run=randomUUID(),state=newPagedShadowRun({runId:run,scanStartedAt:'2026-11-14T20:00:00Z'});
 await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,$3)',[run,state,cap]));
 const lease=await scalar('select shadow_agent.claim($1,60) as value',[run]);
 const bind=c=>scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[run,lease,c]);
 await bind(boundConfig);
 await scalar('select shadow_agent.paged_append($1,$2,0,$3) as value',[run,lease,[candidate]]);
 await scalar('select shadow_agent.paged_append($1,$2,1,$3) as value',[run,lease,[]]);
 await scalar('select shadow_agent.paged_begin($1,$2,2,25) as value',[run,lease]);
 const reserve=(rev=3,hash='a'.repeat(64))=>scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,0.1) as value',[run,lease,rev,hash]);
 const settle=(attempt,status,cost,audit)=>scalar('select shadow_agent.paged_settle($1,$2,$3,$4,$5) as value',[attempt,lease,status,cost,audit]);
 return {run,lease,bind,reserve,settle};
}
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
 await db.exec('set role service_role');
 const requestProfile={version:'discovery-spike-v1',provider:{only:['fixture/provider'],order:['fixture/provider'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.5,completion:1.5,request:0}},responseFormat:'discovery-json-schema-v1'};
 const reasonedProfile={...requestProfile,version:'discovery-spike-v1.2',reasoning:{effort:'none'}};
 const reasoned=await fixture(1,{...config,requestProfile:reasonedProfile});
 assert.equal(await reasoned.bind({...config,requestProfile:reasonedProfile}),true);
 for(const reasoning of [null,[],{},'none',{effort:'low'},{effort:'none',exclude:true},{effort:'none',max_tokens:100},{exclude:true},{max_tokens:0}])
  await assert.rejects(()=>reasoned.bind({...config,requestProfile:{...reasonedProfile,reasoning}}),/Invalid/);
 await admin(()=>q("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[reasoned.run]));
 const reasonedResume=await scalar('select shadow_agent.claim($1,60) as value',[reasoned.run]);
 assert.equal(await scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[reasoned.run,reasonedResume,{...config,requestProfile:reasonedProfile}]),true);
 await assert.rejects(()=>scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[reasoned.run,reasonedResume,{...config,requestProfile:{...requestProfile,version:reasonedProfile.version}}]),/Immutable/);
 const profiled=await fixture(1,{...config,requestProfile});
 assert.equal(await profiled.bind({...config,requestProfile:structuredClone(requestProfile)}),true);
 await assert.rejects(()=>profiled.bind(config),/Immutable/);
 await assert.rejects(()=>profiled.bind({...config,requestProfile:{...requestProfile,version:'v2'}}),/Immutable/);
 await assert.rejects(()=>profiled.bind({...config,requestProfile:{...requestProfile,provider:{...requestProfile.provider,max_price:{...requestProfile.provider.max_price,prompt:0.6}}}}),/Immutable/);
 const invalidProfiles=[null,[],{},
  {...requestProfile,apiKey:'never-store'},
  {...requestProfile,version:'bad version'},
  {...requestProfile,version:'x'.repeat(65)},
  {...requestProfile,responseFormat:'json_object'},
  {...requestProfile,provider:{...requestProfile.provider,headers:{Authorization:'secret'}}},
  {...requestProfile,provider:{...requestProfile.provider,only:['fixture/provider','other/provider']}},
  {...requestProfile,provider:{...requestProfile.provider,order:['other/provider']}},
  {...requestProfile,provider:{...requestProfile.provider,only:['BAD/provider'],order:['BAD/provider']}},
  {...requestProfile,provider:{...requestProfile.provider,allow_fallbacks:true}},
  {...requestProfile,provider:{...requestProfile.provider,require_parameters:false}},
  {...requestProfile,provider:{...requestProfile.provider,max_price:{prompt:0,completion:1,request:0}}},
  {...requestProfile,provider:{...requestProfile.provider,max_price:{prompt:'0.5',completion:1,request:0}}},
  {...requestProfile,provider:{...requestProfile.provider,max_price:{prompt:0.5,completion:-1,request:0}}},
  {...requestProfile,provider:{...requestProfile.provider,max_price:{prompt:0.5,completion:1,request:0.1}}},
  {...requestProfile,provider:{...requestProfile.provider,max_price:{prompt:0.5,completion:1,request:0,secret:'bad'}}},
 ];
 for(const profile of invalidProfiles)await assert.rejects(()=>profiled.bind({...config,requestProfile:profile}),/Invalid/);
 await assert.rejects(()=>profiled.bind({...config,model:'x'.repeat(8200),requestProfile}),/Invalid/);
 const oversizedProfileJson=JSON.stringify({...config,requestProfile}).replace('\"prompt\":0.5','\"prompt\":'+'1'.repeat(9000));
 await assert.rejects(()=>profiled.bind(oversizedProfileJson),/Invalid/);
 await admin(()=>q("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[profiled.run]));
 const resumedLease=await scalar('select shadow_agent.claim($1,60) as value',[profiled.run]);
 assert.notEqual(resumedLease,profiled.lease);
 assert.equal(await scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[profiled.run,resumedLease,{...config,requestProfile}]),true);
 await assert.rejects(()=>scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[profiled.run,resumedLease,{...config,requestProfile:{...requestProfile,version:'changed-after-resume'}}]),/Immutable/);
 const missing=await fixture();
 const deferred=await missing.reserve();assert.equal(deferred.status,'deferred');assert.equal(deferred.reason,'missing_daily_budget');
 assert.equal(deferred.state.phase,'review');assert.equal(deferred.state.revision,4);assert.equal(deferred.state.activeBatch,null);
 assert.equal(await missing.bind(config),true);
 await assert.rejects(()=>missing.bind({...config,model:'other/model'}),/Immutable/);
 await assert.rejects(()=>missing.bind({...config,apiKey:'do-not-store'}),/Invalid/);
 await assert.rejects(()=>missing.bind({...config,policyVersion:'other'}),/Invalid|Immutable/);
 await admin(()=>q("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,2)"));
 for(const [mode,expected] of [['run','insufficient_budget'],['day','insufficient_budget'],['blocked','spending_blocked']]){
  const f=await fixture(mode==='run'?0.05:1);
  if(mode==='day')await admin(()=>q('update shadow_agent.budgets set limit_credits=0.05'));
  if(mode==='blocked')await admin(()=>q('update shadow_agent.budgets set blocked=true'));
  const result=await f.reserve();assert.equal(result.status,'deferred');assert.equal(result.reason,expected);
  assert.equal((await scalar('select shadow_agent.load($1) as value',[f.run])).phase,'review');
  await admin(()=>q('update shadow_agent.budgets set limit_credits=2,blocked=false'));
 }
 const f=await fixture();
 const reserved=await f.reserve();assert.equal(reserved.status,'reserved');assert.ok(reserved.attemptId);
 await assert.rejects(()=>f.reserve(),/already reserved/);
 await assert.rejects(()=>f.reserve(4,'b'.repeat(64)),/checkpoint|lease|revision/i);
 assert.equal(await scalar('select shadow_agent.dispatch($1,$2) as value',[reserved.attemptId,f.lease]),true);
 const audit={model:config.model,generationId:'fixture-generation',usage};
 await assert.rejects(()=>f.settle(reserved.attemptId,'settled',0.04,{...audit,headers:{secret:'bad'}}),/Invalid/);
 await assert.rejects(()=>f.settle(reserved.attemptId,'settled',0.04,{...audit,model:'other/model'}),/Invalid/);
 await assert.rejects(()=>f.settle(reserved.attemptId,'settled',0.04,{...audit,usage:{...usage,totalTokens:16}}),/Invalid/);
 await assert.rejects(()=>f.settle(reserved.attemptId,'settled',0.05,audit),/Invalid/);
 assert.equal(await f.settle(reserved.attemptId,'settled',0.04,audit),true);
 assert.equal(await f.settle(reserved.attemptId,'settled',0.04,audit),true);
 await assert.rejects(()=>f.settle(reserved.attemptId,'settled',0.04,{...audit,generationId:'changed'}),/Immutable/);
 assert.equal((await scalar('select shadow_agent.paged_commit($1,$2,3,$3) as value',[f.run,f.lease,decision])).reviewedCount,1);
 const unknown=await fixture(),u=await unknown.reserve();
 assert.equal(await scalar('select shadow_agent.dispatch($1,$2) as value',[u.attemptId,unknown.lease]),true);
 assert.equal(await unknown.settle(u.attemptId,'uncertain',null,{errorCode:'timeout'}),true);
 assert.equal((await admin(()=>q('select held_credits::float as held from shadow_agent.runs where id=$1',[unknown.run])))[0].held,0.1);
 await assert.rejects(()=>unknown.reserve(),/already reserved/);
 // Accounting can be reconciled after uncertainty with known trustworthy usage.
 assert.equal(await unknown.settle(u.attemptId,'settled',0.04,{usage,errorCode:'invalid_decision_json'}),true);
 const bypass=await fixture(),b=await bypass.reserve();
 await scalar('select shadow_agent.dispatch($1,$2) as value',[b.attemptId,bypass.lease]);
 await scalar("select shadow_agent.settle($1,$2,'settled',0.04) as value",[b.attemptId,bypass.lease]);
 await assert.rejects(()=>scalar('select shadow_agent.paged_commit($1,$2,3,$3) as value',[bypass.run,bypass.lease,decision]),/audit/i);
 for(const table of ['run_config','attempt_audit','deferrals'])await assert.rejects(()=>q(`select * from shadow_agent.${table}`),/permission denied/);
 console.log('PASS: immutable sanitized config/audit, safe budget-only deferral, no attempted checkpoint retry, atomic settlement and unknown-cost holds');
}finally{await db.close();}
