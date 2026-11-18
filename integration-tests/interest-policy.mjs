import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema shadow_agent;
 create table shadow_agent.verification_jobs(id uuid primary key,status text);
 create table shadow_agent.runs(state jsonb);
 create table shadow_agent.producer_settings(singleton boolean,policy_version text);insert into shadow_agent.producer_settings values(true,'2026-11-14.1');
 create table shadow_agent.runtime_settings(singleton boolean,allowed_source_hosts text[]);insert into shadow_agent.runtime_settings values(true,array['github.com']);
 create function public.warpcore_shadow_select_run() returns text language sql as $$select '2026-11-14.1'$$;
 create function public.warpcore_verification_finish(p_job uuid,p_lease uuid,p_status text,p_receipt uuid default null) returns boolean language plpgsql as $$begin if p_lease is null then return false;end if;update shadow_agent.verification_jobs set status=p_status where id=p_job;return found;end$$;`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261118175407_warpcore_interest_policy_and_reasons.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select public.warpcore_shadow_select_run() v')).rows[0].v,'2026-11-18.1');
 const id='11111111-1111-4111-8111-111111111111';await db.query("insert into shadow_agent.verification_jobs(id,status) values($1,'pending')",[id]);
 const finish=(lease,reason)=>db.query("select public.warpcore_verification_finish($1,$2,'deferred',null,$3) v",[id,lease,reason]);
 assert.equal((await finish(null,'source_timeout')).rows[0].v,false);assert.equal((await db.query('select outcome_reason from shadow_agent.verification_jobs')).rows[0].outcome_reason,null);
 assert.equal((await finish(id,'source_timeout')).rows[0].v,true);assert.equal((await db.query('select outcome_reason from shadow_agent.verification_jobs')).rows[0].outcome_reason,'source_timeout');
 await assert.rejects(()=>finish(id,'private error details'));
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>finish(id,'source_timeout'),/permission/);await db.exec('reset role');}
 console.log('PASS interest policy cutover: selector/version agree; old fenced finish retained; sanitized reason persists only after accepted finish; private access');
}finally{await db.close();}
