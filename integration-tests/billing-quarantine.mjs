// Synthetic disposable SQL only: quarantine never resolves unknown billing.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,scalar=async(s,a=[])=>(await q(s,a))[0].value;
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const model='openai/gpt-oss-120b',key=n=>n.toString(16).padStart(64,'0'),hold=.058983;
const config=m=>({model:m,requestProfile:requestProfileForModel(m),expectedProvider:m===model?'Groq':'DeepInfra',reviewBatchSize:16,maxOutputTokens:8192,maxCostCredits:hold,timeoutMs:30000,maxResponseBytes:200000,policyVersion:'2026-11-14.1',routing:'openrouter-no-fallback'});
const usage=cost=>({promptTokens:100,completionTokens:200,totalTokens:300,costCredits:cost});
async function seed(count){const run=randomUUID();let state=newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()});await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,.5)',[run,state]));const lease=await scalar('select shadow_agent.claim($1,300) value',[run]);await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[run,lease,config(model)]);for(let i=0;i<count;i+=100)state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,Array.from({length:Math.min(count-i,100)},(_,j)=>({id:key(i+j+1),sourceUrl:'https://example.com/'+(i+j),discoveryText:'Synthetic candidate.'}))]);state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[]]);return {run,lease,state};}
async function begin(f,dispatch=true){const next=await scalar('select shadow_agent.paged_begin($1,$2,$3,16) value',[f.run,f.lease,f.state.revision]);f.state=next.state;const a=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,$5) value',[f.run,f.lease,f.state.revision,key(f.state.revision),hold]);if(dispatch)await scalar('select shadow_agent.dispatch($1,$2) value',[a.attemptId,f.lease]);return {attempt:a.attemptId,batch:next.batch};}
const quarantine=(f,revision=f.state.revision,reason='Explicit workflow quarantine after recorded HTTP 429; billing remains unknown and fully held.')=>admin(()=>scalar('select shadow_agent.quarantine_rate_limited_run($1,$2,$3) value',[f.run,revision,reason]));
async function financialHistory(run){return admin(async()=>({attempts:await q('select * from shadow_agent.attempts where run_id=$1 order by checkpoint_revision',[run]),audits:await q('select x.* from shadow_agent.attempt_audit x join shadow_agent.attempts a on a.id=x.attempt_id where a.run_id=$1 order by x.attempt_id,x.status',[run]),config:await q('select * from shadow_agent.run_config where run_id=$1',[run]),captures:await q('select * from shadow_agent.candidates where run_id=$1 order by ordinal',[run]),decisions:await q('select * from shadow_agent.decisions where run_id=$1 order by ordinal',[run]),budget:await q('select * from shadow_agent.budgets order by day'),money:await q('select held_credits,spent_credits,limit_credits from shadow_agent.runs where id=$1',[run])}));}
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const n of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql','failed-run-recovery.sql','billing-quarantine.sql'])await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+n,import.meta.url),'utf8'));
 await q("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");await db.exec('set role service_role');
 const f=await seed(649);
 for(let i=0;i<8;i++){const {attempt,batch}=await begin(f),cost=.0030064875;await scalar("select shadow_agent.paged_settle($1,$2,'settled',$3,$4) value",[attempt,f.lease,cost,{model,provider:'Groq',generationId:'synthetic-'+i,usage:usage(cost)}]);f.state=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) value',[f.run,f.lease,f.state.revision,batch.map(c=>({id:c.id,action:'skip',reason:'Synthetic assessment.',importance:0,relevance:0}))]);}
 const {attempt}=await begin(f);
 await scalar("select shadow_agent.paged_settle($1,$2,'uncertain',null,$3) value",[attempt,f.lease,{errorCode:'http_failure',diagnostic:{httpStatus:429}}]);f.state=await scalar('select shadow_agent.paged_uncertain($1,$2,$3) value',[f.run,f.lease,f.state.revision]);
 assert.equal(f.state.reviewedCount,128);assert.equal(f.state.candidateCount,649);
 const before=await financialHistory(f.run);assert.equal(Number(before.money[0].held_credits),hold);assert.equal(Number(before.money[0].spent_credits),.0240519);
 await assert.rejects(()=>admin(()=>scalar('select shadow_agent.adminclose_known_failed_run($1,$2,$3) value',[f.run,f.state.revision,'Unknown billing cannot close as known.'])),/known failed|unknown cost/);
 for(const reason of [null,'',' ','\u00a0','\u2000','x'.repeat(1001),'bad\nreason','bad\u0085reason'])await assert.rejects(()=>quarantine(f,f.state.revision,reason),/Explicit quarantine reason/);
 assert.equal(await quarantine(f,f.state.revision-1),null,'Stale revision has no mutation');
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await assert.rejects(()=>scalar('select shadow_agent.quarantine_rate_limited_run($1,$2,$3) value',[f.run,f.state.revision,'Worker cannot quarantine.']),/permission denied/);await assert.rejects(()=>q('select * from shadow_agent.billing_quarantine_audit'),/permission denied/);}
 const next=await quarantine(f);assert.equal(next.phase,'deferred');assert.equal(next.revision,f.state.revision+1);assert.equal(next.activeBatch,null);assert.equal(next.candidateCount,649);assert.equal(next.reviewedCount,128);assert.deepEqual(await financialHistory(f.run),before,'No billing, attempts, audits, profile, captures or decisions changed');
 const row=(await admin(()=>q('select * from shadow_agent.runs where id=$1',[f.run])))[0];assert.equal(row.blocked,true);assert.equal(row.lease_token,null);assert.equal(row.lease_until,null);
 assert.equal(await quarantine(f),null,'Replay with old CAS cannot repeat quarantine');
 await assert.rejects(()=>scalar('select shadow_agent.claim($1,60) value',[f.run]),/Quarantined workflow cannot resume/);
 await assert.rejects(()=>scalar('select shadow_agent.reserve($1,$2,$3,$4) value',[f.run,f.lease,key(999),hold]),/Lease lost|Spending blocked/);
 assert.equal(await scalar('select shadow_agent.dispatch($1,$2) value',[attempt,f.lease]),false);
 await assert.rejects(()=>admin(()=>scalar('select shadow_agent.adminclose_known_failed_run($1,$2,$3) value',[f.run,next.revision,'Still unknown billing.'])),/known failed|unknown cost/);
 await admin(async()=>{const audit=(await q('select * from shadow_agent.billing_quarantine_audit where run_id=$1',[f.run]))[0];assert.equal(audit.billing_status,'unknown_held');assert.equal(audit.attempt_id,attempt);assert.equal(Number(audit.held_credits),hold);assert.equal(audit.state_before.phase,'uncertain');assert.equal(audit.state_after.phase,'deferred');await assert.rejects(()=>q('update shadow_agent.billing_quarantine_audit set reason=$1 where run_id=$2',['rewrite',f.run]),/immutable/);await assert.rejects(()=>q('delete from shadow_agent.billing_quarantine_audit where run_id=$1',[f.run]),/immutable/);});
 // A fresh separately configured model can be reviewed under the same budget,
 // which STILL includes the old full worst-case hold. No new attempt is made.
 const successor=await admin(()=>scalar('select shadow_agent.create_validation_run($1,.5) value',['Separate reviewed model validation; never replay prior request.']));
 const successorLease=await scalar('select shadow_agent.claim($1,60) value',[successor]);assert.equal(await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[successor,successorLease,config('google/gemma-4-31b-it')]),true);
 assert.deepEqual((await financialHistory(f.run)).budget,before.budget);
 // All other unknown failure classes and not-yet-completed attempts refuse.
 for(const bad of [{errorCode:'http_failure',diagnostic:{httpStatus:503}},{errorCode:'timeout',diagnostic:{httpStatus:429}},{errorCode:'http_failure'},{status:'reserved'},{status:'dispatched'}]){
  const other=await seed(2),a=await begin(other,bad.status!=='reserved');
  if(!bad.status)await scalar("select shadow_agent.paged_settle($1,$2,'uncertain',null,$3) value",[a.attempt,other.lease,bad]);
  other.state=await scalar('select shadow_agent.paged_uncertain($1,$2,$3) value',[other.run,other.lease,other.state.revision]);
  const original=await financialHistory(other.run);await assert.rejects(()=>quarantine(other),/Recorded HTTP 429|Exactly one audited unknown/);assert.deepEqual(await financialHistory(other.run),original);
 }
 console.log('PASS: owner-only recorded-429 workflow quarantine preserves unknown full hold/spend/history, fences old claims/dispatch, immutable audit, explicit successor and other-unknown refusal');
}finally{await db.close();}
