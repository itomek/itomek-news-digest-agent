// Disposable operations fixtures only; no network, paid calls, or activation.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();const q=async(s,a=[])=>(await db.query(s,a)).rows;const value=async(s,a=[])=>(await q(s,a))[0].v;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema shadow_agent;grant usage on schema shadow_agent to service_role;
 create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean);insert into shadow_agent.producer_settings values(true,false);
 create table shadow_agent.budgets(day date primary key,limit_credits numeric,held_credits numeric default 0,spent_credits numeric default 0,blocked boolean default false);
 create table shadow_agent.fixture_queue(id bigserial);create function shadow_agent.enqueue_continuation() returns bigint language sql as 'insert into shadow_agent.fixture_queue default values returning id';
 create table shadow_agent.runs(id uuid,state jsonb);create table shadow_agent.ranking_runs(finalized_at timestamptz,assessed_count bigint,selected_count int);
 create table shadow_agent.attempts(status text);create table shadow_agent.verification_jobs(status text,handoff_status text);
 create table public.warpcore_curator_inbox(id int primary key,story_key text,actor_kind text,state text,created_at timestamptz default now());
 create table public.warpcore_publications(story_key text,state text,prepared_at timestamptz default now(),last_checked_at timestamptz);
 create table public.warpcore_source_sync(outcome text,coverage_gap boolean,last_success_at timestamptz,last_attempt_at timestamptz,covered_through timestamptz);
 grant select,insert,update on public.warpcore_curator_inbox to service_role;`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/runtime-bootstrap.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/operations.sql',import.meta.url),'utf8'));
 const ensure=()=>value('select shadow_agent.ensure_daily_budget() v');const health=()=>value('select public.warpcore_agent_health() v');
 assert.equal(await value('select shadow_agent.budgeted_enqueue() v'),null);assert.equal((await q('select count(*)::int n from shadow_agent.fixture_queue'))[0].n,0);
 assert.equal(await ensure(),false);assert.equal((await q('select count(*)::int n from shadow_agent.budgets'))[0].n,0);
 await q("insert into public.warpcore_curator_inbox(id,story_key,actor_kind,state) values(0,'default-dot','dot','pending')");
 await db.exec('update shadow_agent.spending_policy set enabled=true');assert.equal(await ensure(),false);await db.exec('update shadow_agent.producer_settings set enabled=true');
 await db.exec("insert into shadow_agent.budgets values((now() at time zone 'utc')::date-1,2,.05,19.9,false)");assert.equal(await ensure(),false,'Outstanding holds consume lifetime headroom');
 await db.exec("update shadow_agent.budgets set held_credits=.09;update shadow_agent.runtime_settings set model='google/gemma-4-26b-a4b-it'");assert.equal(await ensure(),false,'Gemma .036045 floor includes existing unknown holds');assert.equal((await health()).activeModel.maxCostCredits,.036045);
 await db.exec("update shadow_agent.budgets set held_credits=0");assert.equal(await ensure(),true,'Gemma approved ceiling fits protected lifetime headroom');await db.exec("update shadow_agent.runtime_settings set model='openai/gpt-oss-120b'");
 assert.ok(await value('select shadow_agent.budgeted_enqueue() v'));assert.equal((await q('select count(*)::int n from shadow_agent.fixture_queue'))[0].n,1);
 await db.exec("begin;update shadow_agent.runtime_settings set model='google/gemma-4-26b-a4b-it';update shadow_agent.budgets set limit_credits=.03 where day=(now() at time zone 'utc')::date");assert.equal(await ensure(),false,'Existing smaller daily cap is never raised for Gemma');assert.equal((await health()).activeModel.maxCostCredits,.036045);await db.exec('rollback');
 const day=(await q("select * from shadow_agent.budgets where day=(now() at time zone 'utc')::date"))[0];assert.equal(Number(day.limit_credits),.1,'Rollover bounded by lifetime remaining');
 await db.exec("update shadow_agent.budgets set spent_credits=0 where day<(now() at time zone 'utc')::date");assert.equal(await ensure(),true);assert.equal(Number((await q("select limit_credits from shadow_agent.budgets where day=(now() at time zone 'utc')::date"))[0].limit_credits),.1,'Never expand an existing daily budget');
 await assert.rejects(()=>q('update shadow_agent.spending_policy set daily_limit_credits=2.01'),/check constraint/);await assert.rejects(()=>q('update shadow_agent.spending_policy set lifetime_limit_credits=20.01'),/check constraint/);
 // Explicit NULL removes application caps; accounting and disabled gates remain.
 await db.exec('begin');
 await db.exec("update shadow_agent.spending_policy set daily_limit_credits=null,lifetime_limit_credits=null;update shadow_agent.budgets set limit_credits=null where day=(now() at time zone 'utc')::date");
 assert.equal(await ensure(),true,'No application cap remains when both limits are NULL');
 assert.equal((await health()).spendingPolicy.dailyLimitCredits,null);assert.equal((await health()).spendingPolicy.lifetimeLimitCredits,null);
 await db.exec("delete from shadow_agent.budgets where day=(now() at time zone 'utc')::date;update shadow_agent.budgets set spent_credits=100,held_credits=50");
 assert.equal(await ensure(),true,'Previous spending/holds do not impose a hidden lifetime cap');
 assert.equal((await q("select limit_credits from shadow_agent.budgets where day=(now() at time zone 'utc')::date"))[0].limit_credits,null,'UTC rollover retains uncapped mode');
 await db.exec("update shadow_agent.spending_policy set enabled=false");assert.equal(await ensure(),false,'Disabling the worker remains independent of spending caps');
 await db.exec('rollback');
 await db.exec("update public.warpcore_curator_inbox set state='processed' where id=0;insert into public.warpcore_curator_inbox(id,story_key,actor_kind,state) values(1,'one','dot','pending');update shadow_agent.spending_policy set exclusive_agent=true");
 await assert.rejects(()=>q("insert into public.warpcore_curator_inbox values(2,'two','dot','pending',now())"),/exclusive/);
 await q("update public.warpcore_curator_inbox set state='processed' where id=1");await q("insert into public.warpcore_curator_inbox(id,story_key,actor_kind,state) values(2,'two','agent','pending')");
 await db.exec('update shadow_agent.spending_policy set exclusive_agent=false');await q("insert into public.warpcore_curator_inbox(id,story_key,actor_kind,state) values(3,'three','dot','pending')");
 await db.exec("insert into shadow_agent.runs values(gen_random_uuid(),'{\"storageKind\":\"paged-v1\",\"phase\":\"review\",\"scanStartedAt\":\"2026-11-16T20:00:00Z\",\"candidateCount\":405,\"reviewedCount\":400}');insert into shadow_agent.ranking_runs values(now(),405,5);insert into shadow_agent.verification_jobs values('uncertain','pending');insert into shadow_agent.attempts values('uncertain');insert into public.warpcore_publications(story_key,state) values('two','prepared'),('old','published'),('manual','manual_review');insert into public.warpcore_source_sync values('failed',true,null,now(),null)");
 await db.exec('set role service_role');const status=await health();assert.equal(status.queue.distinctStories,3);assert.equal(status.latestDiscovery.candidateCount,405);assert.equal(status.sourceHealth.coverageGapCount,1);assert.equal(status.publications.publishedCount,1);assert.equal(status.publications.authoritativePublishedAt,null);assert.ok(status.attentionKeys.includes('verification_uncertain'));await assert.rejects(ensure,/permission/);await assert.rejects(()=>value('select shadow_agent.budgeted_enqueue() v'),/permission/);await assert.rejects(()=>q('select * from shadow_agent.spending_policy'),/permission/);await db.exec('reset role');
 await db.exec('drop table public.warpcore_source_sync');assert.equal((await health()).sourceHealth.installed,false,'Missing source-health installation is explicit');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(health,/permission/);await assert.rejects(ensure,/permission/);await assert.rejects(()=>value('select shadow_agent.budgeted_enqueue() v'),/permission/);await db.exec('reset role');}
 assert.equal(JSON.stringify(status).includes('http'),false,'Health exposes no source URLs');
 console.log('PASS: disabled policy, UTC rollover, lifetime holds, immutable existing daily cap, reversible new-Dot fence, safe health aggregates and private provisioning');
}finally{await db.close();}
