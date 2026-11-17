// Real independent PostgreSQL sessions; exclusively disposable loopback fixture.
import {Client} from 'pg';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const u=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'http://invalid');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!='/warpcore_test'||u.search||u.hash)throw Error('Disposable loopback warpcore_test required');
const clients=Array.from({length:2},()=>new Client({connectionString:u.href})),[a,b]=clients;const q=(c,s,args=[])=>c.query(s,args);const value=async(c,s,args=[])=> (await q(c,s,args)).rows[0].v;
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>q(c,"set statement_timeout='5s'")));
 assert.equal(await value(a,"select to_regnamespace('shadow_agent') is null v"),true,'Refuse existing fixture');
 await q(a,"do $$declare role_name text;begin foreach role_name in array array['anon','authenticated','service_role'] loop if not exists(select 1 from pg_roles where rolname=role_name) then execute format('create role %I',role_name);end if;end loop;end $$");
 await q(a,await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await q(a,`create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean);insert into shadow_agent.producer_settings values(true,false);
 create table shadow_agent.ranking_runs(finalized_at timestamptz,assessed_count bigint,selected_count int);create table shadow_agent.verification_jobs(status text,handoff_status text);
 create table public.warpcore_curator_inbox(id uuid default gen_random_uuid(),story_key text,actor_kind text,state text,created_at timestamptz default now());
 create table public.warpcore_publications(story_key text,state text,prepared_at timestamptz default now(),last_checked_at timestamptz);
 create function shadow_agent.enqueue_continuation() returns bigint language sql as 'select 1::bigint';`);
 await q(a,await fs.readFile(new URL('../supabase/functions/news-agent/sql/operations.sql',import.meta.url),'utf8'));
 const ensure=c=>value(c,'select shadow_agent.ensure_daily_budget() v');assert.equal(await ensure(a),false);
 await q(a,"insert into shadow_agent.budgets(day,limit_credits,held_credits,spent_credits) select (now() at time zone 'utc')::date-n,2,.01,1.98 from generate_series(1,10)n;update shadow_agent.producer_settings set enabled=true;update shadow_agent.spending_policy set enabled=true");
 await q(a,'begin');assert.equal(await ensure(a),true);let start=Date.now();assert.equal(await ensure(b),false,'Concurrent provisioner refuses in-flight budget creation');assert.ok(Date.now()-start<2000);await q(a,'commit');assert.equal(await ensure(b),true);
 const cap=()=>value(a,"select limit_credits::float8 v from shadow_agent.budgets where day=(now() at time zone 'utc')::date");assert.equal(await cap(),.1);
 const run=randomUUID(),story='a'.repeat(64);await q(a,'insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,.2)',[run,JSON.stringify({phase:'reviewing',activeBatch:[story]})]);const lease=await value(a,'select shadow_agent.claim($1,120) v',[run]);
 await q(a,'begin');const attempt=await value(a,'select shadow_agent.reserve($1,$2,$3,.058983) v',[run,lease,'b'.repeat(64)]);start=Date.now();assert.equal(await ensure(b),false,'Provisioning never races an in-flight reserve');assert.ok(Date.now()-start<2000);await q(a,'commit');assert.equal(await cap(),.1);
 assert.equal(await value(a,'select shadow_agent.dispatch($1,$2) v',[attempt,lease]),true);
 await q(a,'begin');assert.equal(await value(a,"select shadow_agent.settle($1,$2,'settled',.02) v",[attempt,lease]),true);assert.equal(await ensure(b),false,'Provisioning never races settlement');await q(a,'commit');assert.equal(await ensure(b),true);assert.equal(await cap(),.1);
 const totals=(await q(a,'select sum(spent_credits)::float8 spent,sum(held_credits)::float8 held,count(*)::int days from shadow_agent.budgets')).rows[0];assert.equal(totals.spent,19.82);assert.equal(totals.held,.1);assert.equal(totals.days,11);
 await q(a,'begin');await q(a,"select * from public.warpcore_curator_inbox");await q(a,"select pg_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0))");
 await assert.rejects(()=>q(b,'update shadow_agent.spending_policy set exclusive_agent=true'),e=>e.code==='55P03');await q(a,'rollback');await q(b,'update shadow_agent.spending_policy set exclusive_agent=true');
 await assert.rejects(()=>q(a,"insert into public.warpcore_curator_inbox(story_key,actor_kind,state) values('dot','dot','pending')"),/exclusive/);await q(a,"insert into public.warpcore_curator_inbox(story_key,actor_kind,state) values('agent','agent','pending')");
 console.log('PASS: PostgreSQL concurrent daily provisioning/reserve/settle, immediate busy refusal, clipped lifetime cap unchanged, exact held/spent accounting and atomic producer cutover');
}finally{await Promise.allSettled(clients.map(c=>q(c,'rollback')));await Promise.allSettled(clients.map(c=>c.end()));}
