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
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-producer.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
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
