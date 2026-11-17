// Disposable embedded SQL; no model, network, canonical writes by worker.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows;
const scalar=async(s,a=[])=>(await q(s,a))[0].value;
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const batchSize=Number(process.env.WARPCORE_RANKING_FIXTURE_BATCH??37);
assert.ok(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=100);
const key=n=>n.toString(16).padStart(64,'0');
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const f of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${f}`,import.meta.url),'utf8'));
 const config={model:'openai/gpt-oss-120b',requestProfile:requestProfileForModel('openai/gpt-oss-120b','2026-11-16.4'),expectedProvider:'Groq',maxOutputTokens:100,maxCostCredits:.1,timeoutMs:1000,maxResponseBytes:20000,policyVersion:newPagedShadowRun({runId:randomUUID(),scanStartedAt:'2026-11-14T20:00:00Z'}).policyVersion,routing:'openrouter-no-fallback'};
 await q("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,100)");
 const run=randomUUID();let state=newPagedShadowRun({runId:run,scanStartedAt:'2026-11-14T20:00:00Z'});
 await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,50)',[run,state]);
 await db.exec('set role service_role');let lease=await scalar('select shadow_agent.claim($1,300) as value',[run]);
 const bind=()=>scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[run,lease,config]);
 await assert.rejects(bind,/Ranking contract required/);
 await admin(async()=>{
  await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-ranking.sql',import.meta.url),'utf8'));
  await db.exec(`create table public.warpcore_stories(story_key text primary key,status text);create table public.warpcore_curator_inbox(story_key text);create table public.warpcore_publications(story_key text);`);
  await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-producer.sql',import.meta.url),'utf8'));
  await q("insert into public.warpcore_stories select lpad(to_hex(n),64,'0'),'unverified_review_required' from generate_series(1,405)n");
 });
 assert.equal(await bind(),true);
 const summary=()=>scalar('select public.warpcore_shadow_selection($1) as value',[run]);
 const candidates=Array.from({length:405},(_,i)=>({id:key(i+1),sourceUrl:`https://example.com/${i}`,discoveryText:'Synthetic same source development.'}));
 for(let i=0;i<405;i+=100)state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) as value',[run,lease,state.revision,candidates.slice(i,i+100)]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) as value',[run,lease,state.revision,[]]);
 while(state.reviewedCount<405){
  const next=await scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,lease,state.revision,batchSize]);state=next.state;
  const reserved=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,.1) as value',[run,lease,state.revision,state.activeBatch[0]]);
  await scalar('select shadow_agent.dispatch($1,$2) as value',[reserved.attemptId,lease]);
  await scalar("select shadow_agent.paged_settle($1,$2,'settled',.01,$3) as value",[reserved.attemptId,lease,{model:config.model,generationId:randomUUID(),provider:'Groq',usage:{promptTokens:1,completionTokens:1,totalTokens:2,costCredits:.01}}]);
  const ds=next.batch.map(c=>({id:c.id,action:'verify',reason:'Synthetic evidence.',importance:c.id===key(405)?4:2,relevance:3}));
  for(const bad of [{...ds[0],importance:5},{...ds[0],importance:1.5},{...ds[0],importance:undefined},{...ds[0],action:'skip'}])await assert.rejects(()=>scalar('select shadow_agent.paged_commit($1,$2,$3,$4) as value',[run,lease,state.revision,[bad,...ds.slice(1)]]),/Invalid/);
  state=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) as value',[run,lease,state.revision,ds]);
  assert.deepEqual((await summary()).items,[],'No early shortlist');
  assert.equal((await summary()).assessedCount,state.reviewedCount);
  const old=lease;
  await admin(()=>q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[run]));
  lease=await scalar('select shadow_agent.claim($1,300) as value',[run]);
  assert.equal(await scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,old,state.revision,batchSize]),null);
 }
 // Completion records the live eligible count without constructing a shortlist.
 await admin(async()=>{
  await q('insert into public.warpcore_curator_inbox values($1)',[key(1)]);
  await q('insert into public.warpcore_publications values($1)',[key(2)]);
  await q("update public.warpcore_stories set status='reviewed' where story_key=$1",[key(3)]);
 });
 // A missing canonical exclusion relation fails closed without proposals.
 await admin(()=>db.exec('alter table public.warpcore_publications rename to fixture_hidden_publications'));
 await assert.rejects(()=>scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,lease,state.revision,batchSize]),/does not exist/);
 assert.deepEqual((await summary()).items,[]);
 await admin(()=>db.exec('alter table public.fixture_hidden_publications rename to warpcore_publications'));
 // Lose the lease during completion metadata update: the entire audit rolls back.
 await admin(()=>db.exec(`create function shadow_agent.fixture_expire_finalizer() returns trigger language plpgsql as $$
 begin if new.finalized_at is not null then update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=new.run_id;end if;return new;end $$;
 create trigger fixture_expire_finalizer before update on shadow_agent.ranking_runs for each row execute function shadow_agent.fixture_expire_finalizer();`));
 await assert.rejects(()=>scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,lease,state.revision,batchSize]),/lease lost/i);
 assert.deepEqual((await summary()).items,[]);assert.equal((await summary()).finalizedAt,null);
 await admin(()=>db.exec('drop trigger fixture_expire_finalizer on shadow_agent.ranking_runs;drop function shadow_agent.fixture_expire_finalizer();'));
 const rev=state.revision;
 state=(await scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,lease,rev,batchSize])).state;
 assert.equal(state.phase,'complete');
 const result=await summary();assert.equal(result.assessedCount,405);assert.equal(result.eligibleCount,402);
 assert.deepEqual(result.items,[]);assert.equal(result.selectedCount,0,'Completion is a coverage audit, never a new top-five publication gate');
 assert.ok(result.items.every(i=>i.status==='requires_verification'&&!i.factsVerified&&!i.publicationApproved));
 assert.equal(await scalar('select shadow_agent.ranking_finalize($1,$2,$3) as value',[run,lease,rev]).catch(()=>null),null);
 // Empty and all-skip runs finalize with zero proposals, without filler calls.
 for(const count of [0,3]){
  const id=randomUUID();let checkpoint=newPagedShadowRun({runId:id,scanStartedAt:'2026-11-14T20:00:00Z'});
  await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)',[id,checkpoint]));
  const token=await scalar('select shadow_agent.claim($1,300) as value',[id]);
  await scalar('select shadow_agent.paged_bind_config($1,$2,$3) as value',[id,token,config]);
  if(count)checkpoint=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) as value',[id,token,checkpoint.revision,candidates.slice(0,count)]);
  checkpoint=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) as value',[id,token,checkpoint.revision,[]]);
  if(count){
   checkpoint=(await scalar('select shadow_agent.paged_begin($1,$2,$3,10) as value',[id,token,checkpoint.revision])).state;
   const a=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,.1) as value',[id,token,checkpoint.revision,key(99)]);
   await scalar('select shadow_agent.dispatch($1,$2) as value',[a.attemptId,token]);
   await scalar("select shadow_agent.paged_settle($1,$2,'settled',.01,$3) as value",[a.attemptId,token,{model:config.model,generationId:randomUUID(),provider:'Groq',usage:{promptTokens:1,completionTokens:1,totalTokens:2,costCredits:.01}}]);
   checkpoint=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) as value',[id,token,checkpoint.revision,candidates.slice(0,count).map(c=>({id:c.id,action:'skip',reason:'Skipped fixture.',importance:0,relevance:0}))]);
  }
  checkpoint=(await scalar('select shadow_agent.paged_begin($1,$2,$3,10) as value',[id,token,checkpoint.revision])).state;
  assert.equal(checkpoint.phase,'complete');
  const result=await scalar('select public.warpcore_shadow_selection($1) as value',[id]);
  assert.equal(result.assessedCount,count);assert.equal(result.eligibleCount,0);assert.deepEqual(result.items,[]);
 }
 for(const table of ['ranking_runs','selection_items'])await assert.rejects(()=>q(`select * from shadow_agent.${table}`),/permission denied/);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(summary,/permission denied/);}
 console.log('PASS: 405 durable assessments, no final shortlist, restart/lease fencing, score rejection, no early proposals, live exclusion fallthrough and private RPC');
}finally{await db.close();}
