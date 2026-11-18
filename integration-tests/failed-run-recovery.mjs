import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
// Owner-only recovery of known billed invalid completion; no live calls or replay.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,scalar=async(s,a=[])=>(await q(s,a))[0].value;
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const model='openai/gpt-oss-120b',key=n=>n.toString(16).padStart(64,'0');
const config=profile=>({model,requestProfile:profile,expectedProvider:'Groq',reviewBatchSize:16,maxOutputTokens:8192,maxCostCredits:.058983,timeoutMs:30000,maxResponseBytes:200000,policyVersion:POLICY_VERSION,routing:'openrouter-no-fallback'});
const usage=cost=>({promptTokens:100,completionTokens:200,totalTokens:300,costCredits:cost});
async function seed(count,version='2026-11-16.3'){
 const run=randomUUID();let state=newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()});
 await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,.5)',[run,state]));
 const lease=await scalar('select shadow_agent.claim($1,300) value',[run]);
 await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[run,lease,config(requestProfileForModel(model,version))]);
 const candidates=Array.from({length:count},(_,i)=>({id:key(i+1),sourceUrl:'https://example.com/'+i,discoveryText:'Synthetic offline candidate.'}));
 for(let i=0;i<count;i+=100)state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,candidates.slice(i,i+100)]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[]]);
 return {run,lease,state};
}
async function begin(f){const next=await scalar('select shadow_agent.paged_begin($1,$2,$3,16) value',[f.run,f.lease,f.state.revision]);f.state=next.state;const a=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,.058983) value',[f.run,f.lease,f.state.revision,key(f.state.revision)]);await scalar('select shadow_agent.dispatch($1,$2) value',[a.attemptId,f.lease]);return {attempt:a.attemptId,batch:next.batch};}
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const name of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql','failed-run-recovery.sql'])await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+name,import.meta.url),'utf8'));
 await q("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
 await db.exec('set role service_role');const f=await seed(650);
 for(let i=0;i<3;i++){
  const {attempt,batch}=await begin(f),cost=.00188685;
  await scalar("select shadow_agent.paged_settle($1,$2,'settled',$3,$4) value",[attempt,f.lease,cost,{model,provider:'Groq',generationId:'synthetic-success-'+i,usage:usage(cost)}]);
  f.state=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) value',[f.run,f.lease,f.state.revision,batch.map(c=>({id:c.id,action:'skip',reason:'Synthetic reviewed item.',importance:0,relevance:0}))]);
 }
 const {attempt}=await begin(f),cost=.0019665;
 const settle=diagnostic=>scalar("select shadow_agent.paged_settle($1,$2,'settled',$3,$4) value",[attempt,f.lease,cost,{errorCode:'incomplete_decisions',usage:usage(cost),diagnostic}]);
 for(const d of [{},{body:'secret'},{messages:[]},{apiKey:'secret'},{generationId:'x'.repeat(257)},{model:'bad\nmodel'},{model:'bad\u0085model'},{generationId:'\u00a0padded'},{provider:' padded'},{httpStatus:99},{httpStatus:600},{httpStatus:200.5},{decisionIndex:100},{decisionIndex:-1},{decisionIndex:1.5},{validationIssue:'arbitrary error text'}])await assert.rejects(()=>settle(d),/Invalid error diagnostic/);
 const diagnostic={generationId:'synthetic-known-failure',model,provider:'UnexpectedKnownProvider',httpStatus:200,validationIssue:'invalid_scores',decisionIndex:15};
 assert.equal(await settle(diagnostic),true,'Error diagnostics do not falsify or require the expected route');
 f.state=await scalar('select shadow_agent.paged_uncertain($1,$2,$3) value',[f.run,f.lease,f.state.revision]);
 assert.equal(f.state.revision,16);assert.equal(f.state.candidateCount,650);assert.equal(f.state.reviewedCount,48);
 const before=await admin(async()=>({attempts:await q('select * from shadow_agent.attempts where run_id=$1 order by checkpoint_revision',[f.run]),config:await q('select config from shadow_agent.run_config where run_id=$1',[f.run]),budget:await q('select * from shadow_agent.budgets'),decisions:await q('select * from shadow_agent.decisions where run_id=$1 order by ordinal',[f.run])}));
 assert.equal((await admin(()=>q('select spent_credits::float spent,held_credits::float held from shadow_agent.runs where id=$1',[f.run])))[0].spent,.00762705);
 for(const role of ['anon','authenticated','service_role']){
  await db.exec('set role '+role);
  await assert.rejects(()=>scalar('select shadow_agent.adminclose_known_failed_run($1,$2,$3) value',[f.run,16,'Known billed incomplete decisions; preserve history.']),/permission denied/);
  await assert.rejects(()=>scalar('select shadow_agent.create_validation_run($1,.5) value',['Owner validation']),/permission denied/);
  await assert.rejects(()=>q('select * from shadow_agent.run_recovery_audit'),/permission denied/);
 }
 await admin(async()=>{
  assert.equal(await scalar('select shadow_agent.adminclose_known_failed_run($1,15,$2) value',[f.run,'Stale owner request']),null);
  const next=await scalar('select shadow_agent.adminclose_known_failed_run($1,16,$2) value',[f.run,'Known billed fourth batch failed coverage; fresh v4 validation separately.']);
  assert.equal(next.phase,'deferred');assert.equal(next.revision,17);assert.equal(next.activeBatch,null);assert.equal(next.candidateCount,650);assert.equal(next.reviewedCount,48);
  assert.equal(await scalar('select shadow_agent.adminclose_known_failed_run($1,16,$2) value',[f.run,'Replay refusal']),null);
  const after={attempts:await q('select * from shadow_agent.attempts where run_id=$1 order by checkpoint_revision',[f.run]),config:await q('select config from shadow_agent.run_config where run_id=$1',[f.run]),budget:await q('select * from shadow_agent.budgets'),decisions:await q('select * from shadow_agent.decisions where run_id=$1 order by ordinal',[f.run])};assert.deepEqual(after,before);
  assert.equal((await q('select count(*)::int n from shadow_agent.candidates where run_id=$1',[f.run]))[0].n,650);
  const record=(await q('select * from shadow_agent.run_recovery_audit where run_id=$1',[f.run]))[0];assert.equal(record.failed_attempt_id,attempt);assert.equal(record.state_before.phase,'uncertain');assert.equal(record.state_after.phase,'deferred');
  await assert.rejects(()=>q('update shadow_agent.run_recovery_audit set reason=$1 where run_id=$2',['rewrite',f.run]),/immutable/);await assert.rejects(()=>q('delete from shadow_agent.run_recovery_audit where run_id=$1',[f.run]),/immutable/);
  for(const limit of [0,-1,.50001,null])await assert.rejects(()=>scalar('select shadow_agent.create_validation_run($1,$2) value',['Invalid cap',limit]),/Validation limit/);
 });
 const start=Date.now(),fresh=await admin(()=>scalar('select shadow_agent.create_validation_run($1,.5) value',['Fresh keyed ranked v4 validation with real timestamp.']));
 const freshState=await scalar('select shadow_agent.load($1) value',[fresh]);assert.ok(Date.parse(freshState.scanStartedAt)>=start-1000&&Date.parse(freshState.scanStartedAt)<=Date.now()+1000);assert.equal(freshState.phase,'scan');assert.equal(freshState.candidateCount,0);
 assert.equal(await scalar('select public.warpcore_shadow_select_run() value'),null,'Disabled producer remains disabled');
 await admin(()=>q("update shadow_agent.producer_settings set enabled=true,policy_version='2026-11-14.1',run_limit_credits=.5"));
 assert.equal(await scalar('select public.warpcore_shadow_select_run() value'),fresh,'Normal selector resumes manual validation without a forged hourly slot');
 assert.equal((await admin(()=>q('select count(*)::int n from shadow_agent.producer_slots')))[0].n,0);
 const lease=await scalar('select shadow_agent.claim($1,300) value',[fresh]),v4=requestProfileForModel(model,'2026-11-16.4');
 assert.equal(v4.version,'2026-11-16.4');assert.equal(await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[fresh,lease,config(v4)]),true);
 assert.equal((await admin(()=>q('select assessed_count::int n from shadow_agent.ranking_runs where run_id=$1',[fresh])))[0].n,0);
 await admin(async()=>{await assert.rejects(()=>scalar('select shadow_agent.create_validation_run($1,.5) value',['Duplicate unfinished validation']),/unfinished/);});
 // Unknown paid outcomes remain held and cannot be administratively classified as known failures.
 const unknown=await seed(1),u=await begin(unknown);
 await scalar("select shadow_agent.paged_settle($1,$2,'uncertain',null,$3) value",[u.attempt,unknown.lease,{errorCode:'timeout',diagnostic:{httpStatus:504}}]);
 unknown.state=await scalar('select shadow_agent.paged_uncertain($1,$2,$3) value',[unknown.run,unknown.lease,unknown.state.revision]);
 await admin(async()=>{await assert.rejects(()=>scalar('select shadow_agent.adminclose_known_failed_run($1,$2,$3) value',[unknown.run,unknown.state.revision,'Must not close an unknown cost']),/known failed|unknown cost/);assert.equal((await q('select status from shadow_agent.attempts where id=$1',[u.attempt]))[0].status,'uncertain');assert.equal(Number((await q('select held_credits from shadow_agent.runs where id=$1',[unknown.run]))[0].held_credits),.058983);});
 console.log('PASS: v4 ranked binding, bounded error diagnostics, owner-only known-billed recovery preserves 650/48 history/costs, immutable audit, real-clock manual validation and unknown-cost refusal');
}finally{await db.close();}
