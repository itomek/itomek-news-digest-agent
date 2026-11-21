import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
const migration=await fs.readFile(new URL('../supabase/migrations/20261121215230_warpcore_full_history_editorial_policy.sql',import.meta.url),'utf8');
for(const previous of ['2026-11-19.1']){
 const db=new PGlite();try{
  await db.exec(`create schema shadow_agent;create table shadow_agent.runs(state jsonb,lease_until timestamptz);
   create table shadow_agent.producer_settings(singleton boolean,enabled boolean,policy_version text);
   insert into shadow_agent.producer_settings values(true,true,'${previous}');
   create function public.warpcore_shadow_select_run() returns text language sql as $$select policy_version from shadow_agent.producer_settings where policy_version in ('2026-11-14.1','${previous}')$$;
   create function shadow_agent.create_validation_run(text,numeric) returns text language sql as $$select '${previous}'$$;`);
  await assert.rejects(db.exec(migration),/Pause producer/);await db.exec('rollback;update shadow_agent.producer_settings set enabled=false;');
  await db.exec(`insert into shadow_agent.runs values('{"storageKind":"paged-v1","phase":"review"}',null)`);
  await assert.rejects(db.exec(migration),/Drain discovery/);await db.exec('rollback;delete from shadow_agent.runs;');
  await db.exec(`insert into shadow_agent.runs values('{}',clock_timestamp()+interval '1 minute')`);
  await assert.rejects(db.exec(migration),/drain leases/);await db.exec('rollback;delete from shadow_agent.runs;');
  await db.exec(migration);
  assert.equal((await db.query('select public.warpcore_shadow_select_run() v')).rows[0].v,POLICY_VERSION);
  assert.equal((await db.query("select shadow_agent.create_validation_run('fixture',1) v")).rows[0].v,POLICY_VERSION);
  const settings=(await db.query('select enabled,policy_version from shadow_agent.producer_settings')).rows[0];
  assert.equal(settings.policy_version,POLICY_VERSION);assert.equal(settings.enabled,false);
  for(const historical of ['2026-11-14.1',previous]){await db.query('update shadow_agent.producer_settings set policy_version=$1',[historical]);assert.equal((await db.query('select public.warpcore_shadow_select_run() v')).rows[0].v,historical);}
  console.log('PASS full-history editorial cutover from '+previous+': active work fenced; selector, validation and settings agree; producer stays paused');
 }finally{await db.close();}
}
