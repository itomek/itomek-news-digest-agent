import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
export async function setup(db,{installRecovery=true}={}){
 await db.exec("do $$declare role_name text;begin foreach role_name in array array['anon','authenticated','service_role'] loop if not exists(select 1 from pg_roles where rolname=role_name) then execute format('create role %I',role_name);end if;end loop;end $$;");
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await db.exec(`create table shadow_agent.ranking_runs(run_id uuid primary key,finalized_at timestamptz,assessed_count bigint default 0);
 create table shadow_agent.candidates(run_id uuid,ordinal bigint,candidate_id text,candidate jsonb);
 create table shadow_agent.decisions(run_id uuid,ordinal bigint,decision jsonb);create table shadow_agent.selection_items(run_id uuid,ordinal bigint,rank int);
 create table public.warpcore_stories(story_key text,status text,collected_at timestamptz default now());
 create table public.warpcore_candidates(story_key text,source_type text,source_created_at timestamptz,source_url text,text text,collected_at timestamptz,uri text);
 create table public.warpcore_publications(story_key text,state text);
 create table public.warpcore_curator_inbox(id uuid primary key default gen_random_uuid(),verification_receipt_id uuid unique,story_key text,run_id uuid,actor_kind text,state text default 'pending');
 create schema agent_verification;create table agent_verification.receipts(id uuid primary key,material jsonb);create function agent_verification.receipt_current(uuid) returns boolean language sql as 'select true';
 create function public.warpcore_agent_submit(uuid) returns uuid language sql as 'select null::uuid';
 create table shadow_agent.health_progress(entity text,entity_id text,created_at timestamptz,progressed_at timestamptz,primary key(entity,entity_id));`);
 await db.exec((await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-producer.sql',import.meta.url),'utf8')).split('create function public.warpcore_shadow_claim(')[0].replace(" if to_regprocedure('shadow_agent.unpaid_verification_retry_available()') is not null then if shadow_agent.unpaid_verification_retry_available() then return null;end if;end if;\n",'')+'commit;');
 await db.exec((await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-jobs.sql',import.meta.url),'utf8')).replace(" if to_regprocedure('shadow_agent.advance_unpaid_verification_retry()') is not null then perform shadow_agent.advance_unpaid_verification_retry();end if;\n",''));
 await db.exec(`alter table shadow_agent.verification_jobs add column outcome_reason text;
 create function public.warpcore_verification_finish(p_job uuid,p_lease uuid,p_status text,p_receipt uuid,p_reason text) returns boolean language plpgsql security definer set search_path='' as $$begin if not public.warpcore_verification_finish(p_job,p_lease,p_status,p_receipt) then return false;end if;update shadow_agent.verification_jobs set outcome_reason=p_reason where id=p_job;return true;end $$;
 update shadow_agent.producer_settings set enabled=true,run_limit_credits=1,policy_version='2026-11-21.1';
 update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=.036045;`);
 if(installRecovery)await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/unpaid-verification-recovery.sql',import.meta.url),'utf8'));
}
export async function fixture(db,reason='source_timeout'){
 const parent=randomUUID(),child=randomUUID(),job=randomUUID(),story=randomUUID().replaceAll('-','').padStart(64,'a'),oldLease=randomUUID();
 await db.query("insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)",[parent,{storageKind:'paged-v1',phase:'complete',reviewedCount:1}]);
 await db.query("insert into shadow_agent.runs(id,state,revision,limit_credits,lease_token,lease_until) values($1,$2,1,.036045,$3,now()-interval '20 minutes')",[child,{storageKind:'verification-v1',runId:child,phase:'deferred',revision:1,activeBatch:null,publishingEnabled:false,parentReviewedCount:1},oldLease]);
 await db.query("insert into shadow_agent.verification_jobs(id,ranking_run_id,story_key,child_run_id,status,outcome_reason) values($1,$2,$3,$4,'deferred',$5)",[job,parent,story,child,reason]);
 await db.query("insert into shadow_agent.health_progress values('verification_jobs',$1,now()-interval '1 hour',now()-interval '16 minutes')",[job]);
 return {parent,child,job,story,oldLease};
}
