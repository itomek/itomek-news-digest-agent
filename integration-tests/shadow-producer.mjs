// Disposable embedded PostgreSQL only. No production, HTTP, model or publishing.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createCandidateSource} from '../supabase/functions/news-agent/candidate-source.mjs';
import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
const db=new PGlite();
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const key=n=>n.toString(16).padStart(64,'0');
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(`create table public.warpcore_stories(story_key text primary key,status text,collected_at timestamptz);
 create table public.warpcore_candidates(uri text primary key,story_key text,source_type text,source_created_at timestamptz,source_url text,text text,collected_at timestamptz);
 create table public.warpcore_curator_inbox(story_key text,state text);
 create table public.warpcore_publications(story_key text,state text);`);
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
 await db.exec('set role service_role');
 const select=()=>scalar('select public.warpcore_shadow_select_run() as value');
 assert.equal(await select(),null,'Disabled by default');
 for(const table of ['producer_settings','producer_slots','runs'])await assert.rejects(()=>q(`select * from shadow_agent.${table}`),/permission denied/);
 await assert.rejects(()=>q('update shadow_agent.producer_settings set enabled=true'),/permission denied/);
 await db.exec('reset role');
 await q('update shadow_agent.producer_settings set enabled=true');
 await assert.rejects(()=>select(),/configuration/);
 await q('update shadow_agent.producer_settings set run_limit_credits=1,policy_version=$1',[POLICY_VERSION]);
 await db.exec('set role service_role');
 const first=await select();assert.match(first,/^[a-f0-9-]{36}$/);
 assert.equal(await select(),first,'Repeat trigger selects same resumable run');
 const state=await scalar('select public.warpcore_shadow_load($1) as value',[first]);
 assert.equal(state.storageKind,'paged-v1');assert.equal(state.policyVersion,POLICY_VERSION);assert.equal(state.candidateCount,0);assert.equal(state.publishingEnabled,false);
 assert.ok(Number.isFinite(Date.parse(state.scanStartedAt)));
 const lease=await scalar('select public.warpcore_shadow_claim($1,60) as value',[first]);
 assert.equal(await select(),null,'Leased incomplete run blocks creation');
 assert.equal((await scalar('select public.warpcore_shadow_paged_append($1,$2,0,$3) as value',[first,lease,[]])).phase,'review');
 assert.equal((await scalar('select public.warpcore_shadow_paged_begin($1,$2,1,25) as value',[first,lease])).state.phase,'complete');
 assert.equal(await select(),null,'One run per UTC-hour slot even after completion');
 await db.exec('reset role');
 assert.equal((await q('select count(*)::int as n from shadow_agent.budgets'))[0].n,0,'Selector cannot create budgets');
 // Simulate an elapsed hour with administrative-only fixture mutation.
 await q("update shadow_agent.producer_slots set utc_hour=utc_hour-interval '1 hour'");
 await db.exec('set role service_role');
 const second=await select();assert.notEqual(second,first);assert.equal(await select(),second);
 await db.exec('reset role');
 await q("update shadow_agent.runs set state=jsonb_set(state,'{phase}','\"uncertain\"'::jsonb) where id=$1",[second]);
 await db.exec('set role service_role');assert.equal(await select(),null,'Unreconciled outcome holds fresh scans');
 await db.exec('reset role');
 const stamp='2026-11-14T20:00:00Z';
 await q(`insert into public.warpcore_stories select lpad(to_hex(n),64,'0'),'unverified_review_required',$1::timestamptz from generate_series(1,305)n`,[stamp]);
 await q(`insert into public.warpcore_candidates select 'fixture:'||n,lpad(to_hex(n),64,'0'),'rss',$1::timestamptz,'https://example.com/'||n,'Discovery '||n,$1::timestamptz from generate_series(1,305)n`,[stamp]);
 await q("insert into public.warpcore_curator_inbox values ($1,'pending')",[key(2)]);
 await q("insert into public.warpcore_publications values ($1,'published')",[key(3)]);
 await q(`insert into public.warpcore_candidates values ('a-new',$2,'rss',$1::timestamptz+interval '1 minute','https://example.com/new','Newest',$1)`,[stamp,key(1)]);
 const direct=createCandidateSource({query:(sql,args)=>db.query(sql,args)});
 const expected=[];let expectedCursor=null;
 for(;;){const page=await direct({scanStartedAt:stamp,cursor:expectedCursor});if(!page.length)break;expected.push(...page);expectedCursor=page.at(-1).id;}
 await db.exec('set role service_role');
 const sizes=[],all=[];let cursor=null;
 for(;;){const page=await scalar('select public.warpcore_shadow_candidate_page($1,$2) as value',[stamp,cursor]);sizes.push(page.length);if(!page.length)break;all.push(...page);cursor=page.at(-1).story_key;}
 assert.deepEqual(sizes,[100,100,100,3,0]);assert.equal(all[0].excerpt,'Newest');assert.equal(all.at(-1).story_key,key(305));assert.equal(all[0].source_created_at,'2026-11-14T20:01:00.000Z');
 const viaRPC=createCandidateSource({query:async(_sql,[p_started,p_cursor])=>({rows:await scalar('select public.warpcore_shadow_candidate_page($1,$2) as value',[p_started,p_cursor])})});
 const actual=[];let actualCursor=null;
 for(;;){const page=await viaRPC({scanStartedAt:stamp,cursor:actualCursor});if(!page.length)break;actual.push(...page);actualCursor=page.at(-1).id;}
 assert.deepEqual(actual,expected,'RPC query preserves exact direct-adapter pagination semantics');
 await assert.rejects(()=>scalar('select public.warpcore_shadow_candidate_page($1,$2) as value',[stamp,'bad']),/cursor/);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  const permitted=await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'warpcore_shadow_%' and has_function_privilege(current_user,p.oid,'execute')`);
  assert.deepEqual(permitted,[],'Every bridge RPC denies anonymous/authenticated users');
  await assert.rejects(()=>select(),/permission denied/);
  await assert.rejects(()=>scalar('select public.warpcore_shadow_load($1) as value',[first]),/permission denied/);
  await assert.rejects(()=>scalar('select public.warpcore_shadow_candidate_page($1,$2) as value',[stamp,null]),/permission denied/);
 }
 console.log('PASS: disabled administrative selector, durable UTC-hour idempotency/resume/lease/uncertainty holds, guarded RPC wrappers and complete fixed-cutoff candidate pagination');
}finally{await db.close();}

// Real source tables; only verifier tables are minimal isolated shape stubs.
// Administrative fixture setup disables the paid-decision insertion audit solely
// to seed a completed selection without any model call or fabricated paid ledger.
// Separate real-clock fixture: manually completed rankings have no scheduler slot.
const precedence=new PGlite();
try{
 await precedence.exec('create role anon;create role authenticated;create role service_role;');
 await precedence.exec(`create table public.warpcore_stories(story_key text primary key,status text,collected_at timestamptz);
 create table public.warpcore_candidates(uri text primary key,story_key text,source_type text,source_created_at timestamptz,source_url text,text text,collected_at timestamptz);
 create table public.warpcore_curator_inbox(story_key text,state text,verification_receipt_id uuid);
 create table public.warpcore_publications(story_key text,state text);`);
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql'])await precedence.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
 const pq=async(s,a=[])=>(await precedence.query(s,a)).rows;
 const pick=async()=> (await pq('select public.warpcore_shadow_select_run() v'))[0].v;
 await precedence.exec(`update shadow_agent.producer_settings set enabled=true,run_limit_credits=1,policy_version='2026-11-14.1';
 create table shadow_agent.verification_settings(singleton boolean,enabled boolean,submit_enabled boolean,job_limit_credits numeric);
 insert into shadow_agent.verification_settings values(true,true,false,.157287);
 create table shadow_agent.verification_jobs(id uuid default gen_random_uuid(),ranking_run_id uuid,story_key text,child_run_id uuid,status text,receipt_id uuid,handoff_status text);
 insert into shadow_agent.runs(id,state,limit_credits) values('00000000-0000-4000-8000-000000000001','{"phase":"complete","storageKind":"paged-v1"}',1);
 insert into shadow_agent.candidates(run_id,ordinal,candidate_id,candidate) values('00000000-0000-4000-8000-000000000001',0,repeat('a',64),'{}');
 alter table shadow_agent.decisions disable trigger paged_require_audit;
 insert into shadow_agent.decisions(run_id,ordinal,decision) values('00000000-0000-4000-8000-000000000001',0,'{}');
 alter table shadow_agent.decisions enable trigger paged_require_audit;
 insert into shadow_agent.ranking_runs values('00000000-0000-4000-8000-000000000001','2026-11-16.1','importance-relevance-id-v1',1,1,1,0,clock_timestamp());
 insert into shadow_agent.selection_items(run_id,rank,ordinal) values('00000000-0000-4000-8000-000000000001',1,0);`);
 assert.equal(await pick(),null,'Manual completed real-clock shortlist precedes a fresh hourly slot');
 assert.equal((await pq('select count(*)::int n from shadow_agent.producer_slots'))[0].n,0,'No fabricated scheduler slot');
 await precedence.exec('begin;update shadow_agent.verification_settings set enabled=false');
 assert.ok(await pick(),'Disabled verifier permits hourly discovery');await precedence.exec('rollback');
 await precedence.exec(`begin;insert into shadow_agent.runs(id,state,limit_credits) values(gen_random_uuid(),'{"phase":"scan","storageKind":"paged-v1","scanStartedAt":"2026-11-17T00:00:00Z"}',1)`);
 assert.ok(await pick(),'Active discovery resumes before verification');await precedence.exec('rollback');
 await precedence.exec(`insert into shadow_agent.runs(id,state,limit_credits) values('00000000-0000-4000-8000-000000000002','{"phase":"reviewing","storageKind":"verification-v1"}',1);
 insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id,status,handoff_status) values('00000000-0000-4000-8000-000000000001',repeat('a',64),'00000000-0000-4000-8000-000000000002','pending','pending');`);
 assert.equal(await pick(),null,'Unattempted pending job precedes hourly discovery');
 await precedence.exec("begin;update shadow_agent.runs set lease_until=clock_timestamp()+interval '1 minute' where id='00000000-0000-4000-8000-000000000002'");assert.ok(await pick(),'Leased pending job is not claimable');await precedence.exec('rollback');
 await precedence.exec("begin;update shadow_agent.verification_jobs set status='uncertain'");assert.ok(await pick(),'Uncertain jobs cannot authorize verification replay');await precedence.exec('rollback');
 await precedence.exec("begin;update shadow_agent.verification_jobs set status='verified',receipt_id=gen_random_uuid();update shadow_agent.verification_settings set submit_enabled=false");assert.ok(await pick(),'No handoff precedence while submit disabled');await precedence.exec('rollback');
 await precedence.exec("begin;update shadow_agent.verification_jobs set status='verified',receipt_id=gen_random_uuid();update shadow_agent.verification_settings set submit_enabled=true");assert.equal(await pick(),null,'Enabled recoverable handoff precedes discovery');await precedence.exec('rollback');
 await precedence.exec("begin;update shadow_agent.verification_jobs set status='verified',receipt_id=gen_random_uuid();update shadow_agent.verification_settings set submit_enabled=true;insert into public.warpcore_curator_inbox(verification_receipt_id) select receipt_id from shadow_agent.verification_jobs");assert.ok(await pick(),'Already submitted receipt is not recoverable work');await precedence.exec('rollback');
 await precedence.exec("begin;update shadow_agent.verification_jobs set status='verified',receipt_id=gen_random_uuid(),handoff_status='deferred';update shadow_agent.verification_settings set submit_enabled=true");assert.ok(await pick(),'Terminal stale-receipt handoff does not starve discovery');await precedence.exec('rollback');
 // Execute the real claim implementation against the fixture tables: stale
 // reservations get one reconciliation turn, retaining their complete hold.
 const verifierSql=await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-jobs.sql',import.meta.url),'utf8');
 for(const name of ['shadow_agent.verification_lock','public.warpcore_verification_claim']){
  const start=verifierSql.indexOf('create function '+name+'('),end=verifierSql.indexOf('end $$;',start)+'end $$;'.length;
  await precedence.exec(verifierSql.slice(start,end));
 }
 await precedence.exec('begin');
 await precedence.exec(`insert into shadow_agent.budgets values((clock_timestamp() at time zone 'utc')::date,1,0,0,false);
 update shadow_agent.runs set state=state||jsonb_build_object('activeBatch',jsonb_build_array(repeat('a',64))) where id='00000000-0000-4000-8000-000000000002';`);
 const child='00000000-0000-4000-8000-000000000002';
 const token=(await pq('select shadow_agent.claim($1,120) v',[child]))[0].v;
 await pq('select shadow_agent.reserve($1,$2,$3,.157287)',[child,token,'b'.repeat(64)]);
 await pq("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[child]);
 assert.equal(await pick(),null,'Expired attempted pending work gets one reconciliation turn');
 assert.equal((await pq('select public.warpcore_verification_claim() v'))[0].v,null);
 assert.equal((await pq('select status from shadow_agent.verification_jobs'))[0].status,'uncertain','Actual claim classifies lost attempted work');
 assert.equal(Number((await pq('select held_credits from shadow_agent.budgets'))[0].held_credits),.157287,'Reconciliation preserves full unknown hold');
 assert.ok(await pick(),'After reconciliation uncertain work no longer starves discovery');
 await precedence.exec('rollback');
 await precedence.exec("update shadow_agent.verification_jobs set status='deferred'");assert.ok(await pick(),'All resolved jobs open the real current-hour slot');
 console.log('PASS: real-clock manual shortlist verification precedence, disabled/leased/uncertain exclusions, active discovery continuity and resolved queue rollover');
}finally{await precedence.close();}
