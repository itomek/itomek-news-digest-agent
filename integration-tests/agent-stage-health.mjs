import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,h=async()=>(await q('select public.warpcore_agent_health() h'))[0].h;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema shadow_agent;
 create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean);insert into shadow_agent.producer_settings values(true,true);
 create table shadow_agent.budgets(day date,limit_credits numeric,held_credits numeric,spent_credits numeric,blocked boolean);
 create function shadow_agent.enqueue_continuation() returns bigint language sql as 'select 1::bigint';
 create table shadow_agent.runs(id uuid primary key,state jsonb,revision bigint default 0,lease_token uuid,lease_until timestamptz);
 create table shadow_agent.producer_slots(run_id uuid);create table shadow_agent.ranking_runs(run_id uuid,finalized_at timestamptz,assessed_count bigint,selected_count int);
 create table shadow_agent.attempts(status text);
 create table shadow_agent.verification_settings(singleton boolean,enabled boolean,submit_enabled boolean);insert into shadow_agent.verification_settings values(true,true,true);
 create table shadow_agent.verification_jobs(id uuid primary key,child_run_id uuid,status text,handoff_status text,quarantined boolean default false);
 create table public.warpcore_curator_inbox(id uuid primary key,story_key text,actor_kind text,state text,created_at timestamptz default now());
 create table public.warpcore_publications(id uuid primary key,story_key text,state text,prepared_at timestamptz default now(),last_checked_at timestamptz,remote_uri text);
 create table public.system_logs(level text,category text,message text,metadata jsonb);
 create table shadow_agent.fixture_eligible(ranking_run_id uuid,story_key text,ordinal bigint);
 create function shadow_agent.next_verification_candidate() returns table(ranking_run_id uuid,story_key text,ordinal bigint) language sql as 'select * from shadow_agent.fixture_eligible';`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/operations.sql',import.meta.url),'utf8'));
 const run='00000000-0000-0000-0000-000000000001',job='00000000-0000-0000-0000-000000000002';
 await q("insert into shadow_agent.runs(id,state) values($1,'{\"storageKind\":\"verification-v1\",\"phase\":\"reviewing\"}')",[run]);
 await q("insert into shadow_agent.verification_jobs(id,child_run_id,status,handoff_status) values($1,$2,'pending','pending')",[job,run]);
 let health=await h();assert.ok(health.stages.verification.oldestWorkAt,'Real verification state has no scanStartedAt but creation is durable');
 const before=(await q("select progressed_at::text stamp from shadow_agent.health_progress where entity='runs' and entity_id=$1",[run]))[0].stamp;await q("update shadow_agent.runs set revision=revision+1,lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute',state=state||'{\"revision\":1}'::jsonb where id=$1",[run]);assert.equal((await q("select progressed_at::text stamp from shadow_agent.health_progress where entity='runs' and entity_id=$1",[run]))[0].stamp,before,'Lease and revision churn never establishes semantic progress');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/agent-alerts.sql',import.meta.url),'utf8'));await db.exec('update shadow_agent.alert_settings set enabled=true');
 await db.exec("update shadow_agent.health_progress set created_at=now()-interval '1 hour',progressed_at=now()-interval '1 hour'");
 health=await h();assert.equal(health.stages.verification.state,'stalled');await q('select shadow_agent.refresh_alerts()');assert.equal((await q("select active from shadow_agent.alert_state where code='verification_stalled'"))[0].active,true);
 await db.exec('update shadow_agent.producer_settings set enabled=false');health=await h();assert.equal(health.stages.verification.state,'paused');assert.equal(health.operationalHealth.state,'paused');await q('select shadow_agent.refresh_alerts()');assert.equal((await q("select active from shadow_agent.alert_state where code='verification_stalled'"))[0].active,false,'Global producer pause stops verification alerts');await db.exec('update shadow_agent.producer_settings set enabled=true');
 await db.exec('update shadow_agent.verification_settings set enabled=false');health=await h();assert.equal(health.stages.verification.state,'paused');assert.equal(health.operationalHealth.state,'paused');await q('select shadow_agent.refresh_alerts()');assert.equal((await q("select active from shadow_agent.alert_state where code='verification_stalled'"))[0].active,false);
 await db.exec('update shadow_agent.verification_settings set enabled=true');
 await db.exec("insert into public.warpcore_curator_inbox values(gen_random_uuid(),'story','agent','pending',now()-interval '1 hour')");
 await db.exec("update shadow_agent.health_progress set progressed_at=now()-interval '1 hour' where entity='warpcore_curator_inbox'");health=await h();assert.equal(health.stages.curation.backlogCount,1);assert.equal(health.stages.curation.state,'stalled');assert.equal(health.stages.verification.state,'waiting');await q('select shadow_agent.refresh_alerts()');assert.equal((await q("select active from shadow_agent.alert_state where code='curation_stalled'"))[0].active,true);
 await db.exec("update public.warpcore_curator_inbox set state='processed';update shadow_agent.verification_jobs set status='verified';update shadow_agent.verification_settings set submit_enabled=false");
 health=await h();assert.equal(health.stages.handoff.state,'paused');
 await db.exec('update shadow_agent.verification_settings set submit_enabled=true;update shadow_agent.producer_settings set enabled=false');health=await h();assert.equal(health.stages.handoff.state,'paused');await q('select shadow_agent.refresh_alerts()');assert.equal((await q("select active from shadow_agent.alert_state where code='handoff_stalled'"))[0]?.active??false,false,'Global producer pause stops handoff alerts');await db.exec('update shadow_agent.producer_settings set enabled=true');
 await db.exec("update shadow_agent.verification_jobs set handoff_status='submitted';insert into shadow_agent.ranking_runs values('00000000-0000-0000-0000-000000000003',now()-interval '1 hour',1,1);insert into shadow_agent.fixture_eligible values('00000000-0000-0000-0000-000000000003','eligible',0)");
 health=await h();assert.equal(health.stages.verification.unclaimedCount,1);assert.equal(health.stages.verification.state,'stalled','Eligible decisions before first claim remain visible');
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await assert.rejects(()=>q('select * from shadow_agent.health_progress'),/permission/);await db.exec('reset role');}
 console.log('PASS: real verification shape, durable clocks, curator backlog, verifier pause, downstream waiting, unclaimed eligibility and private progress');
}finally{await db.close();}
