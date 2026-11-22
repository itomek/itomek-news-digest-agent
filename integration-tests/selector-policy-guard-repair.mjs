import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const repair=await fs.readFile(new URL('../supabase/migrations/20261122151350_repair_selector_policy_guard.sql',import.meta.url),'utf8');
const broken="settings.policy_version is distinct from '2026-11-19.1','2026-11-21.1'";
const current="settings.policy_version is distinct from '2026-11-21.1'";
const canonical="settings.policy_version not in ('2026-11-14.1','2026-11-18.1','2026-11-18.2','2026-11-19.1','2026-11-21.1')";
for(const guard of [broken,current,canonical,"settings.policy_version is distinct from 'unknown'"]){
 const db=new PGlite();try{
  const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema shadow_agent;
   create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean,policy_version text,run_limit_credits numeric);
   insert into shadow_agent.producer_settings values(true,true,'2026-11-21.1',1);
   create table shadow_agent.runs(id uuid,state jsonb,lease_until timestamptz);insert into shadow_agent.runs values(gen_random_uuid(),'{"phase":"reviewing"}',now()+interval '1 hour');
   create table public.fixture_queue(state text);insert into public.fixture_queue values('pending'),('uncertain');
   create function public.warpcore_shadow_select_run() returns uuid language plpgsql security definer set search_path='' as $selector$
   declare settings shadow_agent.producer_settings;historical_note text:='2026-11-19.1';
   begin
    select * into settings from shadow_agent.producer_settings where singleton;
    if not settings.enabled then return null;end if;
    if settings.run_limit_credits is null or ${guard}
    then raise exception 'Invalid producer configuration';end if;
    return '00000000-0000-0000-0000-000000000001'::uuid;
   end $selector$;
   revoke all on function public.warpcore_shadow_select_run() from public,anon,authenticated;grant execute on function public.warpcore_shadow_select_run() to service_role;`);
  const catalog=async()=>(await q("select oid::text,proowner::text,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.warpcore_shadow_select_run()'::regprocedure"))[0];
  const snapshot=async()=>(await q('select (select jsonb_agg(to_jsonb(s)) from shadow_agent.producer_settings s) settings,(select jsonb_agg(to_jsonb(r)) from shadow_agent.runs r) runs,(select jsonb_agg(to_jsonb(q)) from public.fixture_queue q) queue'))[0];
  const before=await catalog(),rows=await snapshot();
  if(guard===broken)await assert.rejects(q('select public.warpcore_shadow_select_run()'),/query returned 2 columns/);
  if(guard.includes('unknown')){
   await assert.rejects(db.exec(repair),/Unexpected selector policy guard/);await db.exec('rollback');assert.deepEqual(await catalog(),before);assert.deepEqual(await snapshot(),rows);continue;
  }
  await db.exec(repair);const after=await catalog();
  assert.deepEqual({...after,definition:null},{...before,definition:null},'Repair preserves function identity, owner, grants, security and search path');
  assert.ok(after.definition.includes("historical_note text:='2026-11-19.1'"),'Unrelated old-version literal survives');assert.deepEqual(await snapshot(),rows,'Settings, work, live leases and queue states unchanged');
  assert.equal((await q('select public.warpcore_shadow_select_run() v'))[0].v,'00000000-0000-0000-0000-000000000001');
  await db.exec(repair);assert.deepEqual(await catalog(),after,'Repair is idempotent');
  await db.exec('set role service_role');assert.ok((await q('select public.warpcore_shadow_select_run() v'))[0].v);await db.exec('reset role;set role anon');await assert.rejects(q('select public.warpcore_shadow_select_run()'),/permission/);await db.exec('reset role');
  await db.exec("update shadow_agent.producer_settings set enabled=false");assert.equal((await q('select public.warpcore_shadow_select_run() v'))[0].v,null,'Disabled producer gate survives');
  await db.exec("update shadow_agent.producer_settings set enabled=true,run_limit_credits=null");await assert.rejects(q('select public.warpcore_shadow_select_run()'),/Invalid producer configuration/);
  await db.exec("update shadow_agent.producer_settings set run_limit_credits=1,policy_version='unknown'");await assert.rejects(q('select public.warpcore_shadow_select_run()'),/Invalid producer configuration/);
 }finally{await db.close();}
}
console.log('PASS: live malformed strict guard reproduced and repaired; strict/IN idempotence, unknown refusal, runtime gates, OID/ACL and state preservation');
