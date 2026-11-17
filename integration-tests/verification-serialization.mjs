// Disposable SQL only: one history-changing publication at a time, no paid HTTP.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,v=async(s,a=[])=>(await q(s,a))[0]?.v;
const parent=randomUUID(),key=n=>n.toString(16).padStart(64,'0');
try{
 await db.exec('create role anon;create role authenticated;create role service_role');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await db.exec(`create table shadow_agent.ranking_runs(run_id uuid primary key,finalized_at timestamptz,assessed_count bigint default 0);
 create table shadow_agent.candidates(run_id uuid,ordinal bigint,candidate_id text);create table shadow_agent.decisions(run_id uuid,ordinal bigint,decision jsonb);create table shadow_agent.selection_items(run_id uuid,ordinal bigint,rank int);
 create table public.warpcore_stories(story_key text,status text);create table public.warpcore_publications(story_key text primary key,state text);
 create table public.warpcore_curator_inbox(id uuid primary key default gen_random_uuid(),verification_receipt_id uuid unique,story_key text,run_id uuid,actor_kind text,state text default 'pending');
 create schema agent_verification;create table agent_verification.receipts(id uuid primary key,material jsonb);
 create function agent_verification.receipt_current(p_id uuid) returns boolean language sql as 'select not coalesce((material->>''stale'')::boolean,false) from agent_verification.receipts where id=p_id';
 create function public.warpcore_agent_submit(p_id uuid) returns uuid language sql as 'insert into public.warpcore_curator_inbox(verification_receipt_id,story_key,run_id,actor_kind) select p_id,material->>''storyKey'',(material->>''runId'')::uuid,''agent'' from agent_verification.receipts where id=p_id returning id';`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-jobs.sql',import.meta.url),'utf8'));
 await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[parent]);await q('insert into shadow_agent.ranking_runs values($1,clock_timestamp(),3)',[parent]);
 for(let i=1;i<=3;i++){await q('insert into shadow_agent.candidates values($1,$2,$3)',[parent,i-1,key(i)]);await q('insert into shadow_agent.decisions values($1,$2,$3)',[parent,i-1,{action:'verify',importance:3,relevance:3}]);await q("insert into public.warpcore_stories values($1,'unverified_review_required')",[key(i)]);}
 await db.exec("update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=.2;insert into shadow_agent.budgets(day,limit_credits) values((clock_timestamp() at time zone 'utc')::date,2)");
 const claim=()=>v('select public.warpcore_verification_claim() v');
 const reserve=job=>v('select public.warpcore_verification_reserve($1,$2,$3,.036045,$4) v',[job.jobId,job.lease,key(99),{model:'google/gemma-4-26b-a4b-it',expectedProvider:'PrimeIntellect',profileVersion:'2026-11-17.verify.8'}]);
 const first=await claim();assert.equal(first.storyKey,key(1));await reserve(first);await v('select public.warpcore_verification_dispatch($1,$2) v',[first.jobId,first.lease]);
 await v("select public.warpcore_verification_settle($1,$2,'settled',.001,$3) v",[first.jobId,first.lease,{model:'google/gemma-4-26b-a4b-it',provider:'PrimeIntellect',generationId:'gen-synthetic',usage:{promptTokens:1,completionTokens:1,totalTokens:2,costCredits:.001}}]);
 const receipt=randomUUID(),material={runId:parent,storyKey:first.storyKey,requestSha256:key(99),model:'google/gemma-4-26b-a4b-it',requestProfileVersion:'2026-11-17.verify.8',stale:true};
 await q('insert into agent_verification.receipts values($1,$2)',[receipt,material]);
 await assert.rejects(()=>v("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[first.jobId,first.lease,receipt]),/Invalid verification receipt binding/,'History/currentness validation remains mandatory');
 await q('update agent_verification.receipts set material=$2 where id=$1',[receipt,{...material,stale:false}]);assert.equal(await v("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[first.jobId,first.lease,receipt]),true);
 const inbox=await v('select public.warpcore_verification_handoff($1,$2) v',[first.jobId,first.lease]);assert.ok(inbox,'Actual receipt handoff creates the pending inbox item');
 const ledger=()=>v("select jsonb_build_object('attempts',(select jsonb_agg(to_jsonb(a) order by id) from shadow_agent.attempts a),'budgets',(select jsonb_agg(to_jsonb(b)) from shadow_agent.budgets b)) v");
 const before=await ledger();
 // A receipt left by an older worker must not bypass serialization either.
 await db.exec('begin');
 const recoveryChild=randomUUID(),recoveryReceipt=randomUUID();
 await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[recoveryChild]);
 await q('insert into agent_verification.receipts values($1,$2)',[recoveryReceipt,{...material,storyKey:key(3),stale:false}]);
 await q("insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id,status,receipt_id) values($1,$2,$3,'verified',$4)",[parent,key(3),recoveryChild,recoveryReceipt]);
 assert.equal(await claim(),null,'An older unsent receipt waits behind the first unresolved handoff');
 await db.exec('rollback');
 async function blocked(reason){assert.equal(await claim(),null,reason);assert.equal((await q('select count(*)::int n from shadow_agent.verification_jobs'))[0].n,1,'No second paid job allocated');assert.deepEqual(await ledger(),before,'Waiting never changes attempts, settled spend or holds');}
 await blocked('Pending curator handoff blocks the next fresh verification');await q("update public.warpcore_curator_inbox set state='leased' where id=$1",[inbox]);await blocked('Leased curator work also serializes history');
 await q("update public.warpcore_curator_inbox set state='approved' where id=$1",[inbox]);await q("insert into public.warpcore_publications values($1,'prepared')",[first.storyKey]);
 for(const state of ['prepared','sending','uncertain','manual_review']){await q('update public.warpcore_publications set state=$1',[state]);await blocked(state+' publication keeps the next verification queued');}
 await q("update public.warpcore_publications set state='published'");const second=await claim();assert.equal(second.storyKey,key(2),'Terminal publication releases next item');assert.notEqual(second.jobId,first.jobId);assert.deepEqual(await ledger(),before,'Claim alone never spends');
 // A lost paid response must still be classified before the publication gate.
 await reserve(second);await v('select public.warpcore_verification_dispatch($1,$2) v',[second.jobId,second.lease]);await q("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[second.jobId]);await q("update public.warpcore_publications set state='prepared'");const heldBefore=await ledger();assert.equal(await claim(),null);assert.equal((await q('select status from shadow_agent.verification_jobs where id=$1',[second.jobId]))[0].status,'uncertain','Expired attempted work still becomes uncertain before queue serialization');assert.deepEqual(await ledger(),heldBefore,'Full unknown request hold retained, no automatic replay');
 console.log('PASS verification serialization: actual paid SQL settlement/receipt binding/handoff; pending/leased inbox and all live publication states block fresh verification; terminal publication releases next item; stale receipt checks and expired-attempt full holds preserved');
}finally{await db.close();}
