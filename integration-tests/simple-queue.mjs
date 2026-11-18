import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
// Disposable SQL and synthetic model responses only: durable small-item queue.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runPagedShadowInvocation} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,v=async(s,a=[])=>(await q(s,a))[0]?.v;
const key=n=>n.toString(16).padStart(64,'0'),model='fixture/simple-queue',reviewed=[];
const config={enabled:true,model,allowedModels:[model],maxOutputTokens:2000,maxCostCredits:.2,apiKey:'synthetic-key',timeoutMs:1000,leaseSeconds:60};
try{
 await db.exec('create role anon;create role authenticated;create role service_role');
 await db.exec(`create table public.warpcore_stories(story_key text primary key,status text,collected_at timestamptz);
 create table public.warpcore_candidates(uri text primary key,story_key text,source_type text,source_created_at timestamptz,source_url text,text text,collected_at timestamptz);
 create table public.warpcore_curator_inbox(story_key text,state text);create table public.warpcore_publications(story_key text,state text,prepared_at timestamptz);`);
 for(const f of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql','shadow-release.sql'])await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+f,import.meta.url),'utf8'));
 await db.exec("update shadow_agent.producer_settings set enabled=true,run_limit_credits=1,policy_version='"+POLICY_VERSION+"',first_seen_since=clock_timestamp()-interval '1 hour';insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,10)");
 const add=async(n)=>{await q("insert into public.warpcore_stories values($1,'unverified_review_required',clock_timestamp())",[key(n)]);await q("insert into public.warpcore_candidates values($1,$2,'rss',clock_timestamp(),'https://example.com/item','Synthetic new item',clock_timestamp())",['fixture:'+n,key(n)]);};
 const select=()=>v('select public.warpcore_shadow_select_run() v');
 assert.equal(await select(),null,'Empty list creates no scan or billing work');
 for(let i=1;i<=35;i++)await add(i);
 assert.equal((await v('select shadow_agent.queue_summary() v')).waiting,35);
 const fetcher=async(_url,options)=>{
  const input=JSON.parse(JSON.parse(options.body).messages[1].content).candidates;
  reviewed.push(...input.map(c=>c.id));
  return Response.json({id:'synthetic-'+reviewed.length,model,usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:input.map(c=>({id:c.id,action:'skip',reason:'Synthetic irrelevant item.'}))})}}]});
 };
 const invoke=runId=>runPagedShadowInvocation({runId,config,query:(s,a)=>db.query(s,a),fetcher},{reviewBatchSize:16,releaseLeaseOnSuccess:true});
 const runs=[],sizes=[];
 for(const size of [16,16,3]){
  const run=await select();runs.push(run);
  assert.equal(await select(),run,'Concurrent/repeated selector resumes same batch');
  const state=await v('select public.warpcore_shadow_load($1) v',[run]);
  assert.equal(state.phase,'review','No scan stage or full-feed pagination');sizes.push(state.candidateCount);assert.equal(state.candidateCount,size);
  const lease=await v('select public.warpcore_shadow_claim($1,60) v',[run]);assert.ok(lease);assert.equal(await select(),null,'Active owner prevents duplicate batch creation');
  await q("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run]);
  assert.equal((await invoke(run)).state.reviewedCount,size);
  assert.equal((await invoke(run)).state.phase,'complete');
 }
 assert.deepEqual(sizes,[16,16,3]);assert.equal(new Set(runs).size,3,'Same-hour batches can drain without hour slots');assert.deepEqual(reviewed,Array.from({length:35},(_,i)=>key(i+1)));
 assert.equal(await select(),null,'Skipped items are finished and never charged again');
 const summary=await v('select shadow_agent.queue_summary() v');
 assert.equal(summary.waiting,0);assert.equal(summary.reviewed,35);assert.equal(summary.skipped,35);assert.equal(summary.qualified,0);assert.equal(summary.published,0);assert.equal(summary.activeBatches,0);
 await q("update public.warpcore_candidates set collected_at=clock_timestamp(),text='Refreshed source evidence' where story_key=$1",[key(1)]);
 assert.equal(await select(),null,'Refreshing source evidence does not replay a committed skip');
 assert.equal((await q('select count(*)::int n from shadow_agent.producer_slots'))[0].n,0,'No whole-scan scheduler queue created');
 await add(36);const heldRun=await select();
 await assert.rejects(()=>runPagedShadowInvocation({runId:heldRun,config,query:(s,a)=>db.query(s,a),fetcher:async()=>{throw Error('Synthetic lost response');}},{reviewBatchSize:16,releaseLeaseOnSuccess:true}));
 assert.equal(await select(),null,'Unresolved attempt stops automatic replay');
 // Simulate the existing administrator quarantine contract, without releasing money.
 await q("update shadow_agent.runs set state=state||'{\"phase\":\"deferred\",\"activeBatch\":null}'::jsonb,blocked=true where id=$1",[heldRun]);
 const ledger=()=>v("select jsonb_build_object('attempts',(select jsonb_agg(to_jsonb(a) order by id) from shadow_agent.attempts a),'budgets',(select jsonb_agg(to_jsonb(b)) from shadow_agent.budgets b)) v");
 const before=await ledger();assert.equal(await select(),null,'Quarantined unknown paid item cannot become fresh work');assert.deepEqual(await ledger(),before,'Selector preserves full financial history and unknown hold');
 await add(37);const next=await select();assert.ok(next);assert.equal((await v('select public.warpcore_shadow_load($1) v',[next])).candidateCount,1,'Only genuinely new unassessed item enters next batch');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>select(),/permission/);await assert.rejects(()=>v('select shadow_agent.queue_summary() v'),/permission/);await db.exec('reset role');}
 console.log('PASS simple item queue: 35 items drained once in 16/16/3 same-hour batches, no empty scans/hour gate, exclusive leases, source refresh dedup, durable unknown holds and private controls');
}finally{await db.close();}
