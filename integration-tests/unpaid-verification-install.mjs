import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {setup,fixture} from './unpaid-verification-fixture.mjs';
const sql=await fs.readFile(new URL('../supabase/functions/news-agent/sql/unpaid-verification-recovery.sql',import.meta.url),'utf8');
assert.equal(sql,await fs.readFile(new URL('../supabase/migrations/20261123051515_unpaid_verification_source_recovery.sql',import.meta.url),'utf8'));
for(const unknown of [false,true]){
 const db=new PGlite();try{
  await setup(db,{installRecovery:false});const f=await fixture(db);const q=async(s,a=[])=>(await db.query(s,a)).rows;
  const original=(await q("select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) definition"))[0].definition;
  await db.exec(original.replace("settings.policy_version not in ('2026-11-14.1','2026-11-18.1','2026-11-18.2','2026-11-19.1','2026-11-21.1')","settings.policy_version is distinct from '2026-11-21.1'"));
  if(unknown){const definition=(await q("select pg_get_functiondef('public.warpcore_verification_claim()'::regprocedure) definition"))[0].definition;await db.exec(definition.replace("where status='pending' and not quarantined order by id limit 1;","where status='pending' and not quarantined order by id asc limit 1;"));}
  const catalog=async()=>q("select oid::text,proname,proowner::text,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid in ('public.warpcore_shadow_select_run()'::regprocedure,'public.warpcore_verification_claim()'::regprocedure) order by proname");
  const before=await catalog(),runs=await q('select * from shadow_agent.runs order by id');
  if(unknown){await assert.rejects(db.exec(sql),/Unexpected verification claim shape/);await db.exec('rollback');assert.deepEqual(await catalog(),before);assert.deepEqual(await q('select * from shadow_agent.runs order by id'),runs);assert.equal((await q("select to_regclass('shadow_agent.verification_source_retry_audit') missing"))[0].missing,null,'Unknown hook shape rolls back every schema change');continue;}
  await db.exec(sql);const after=await catalog();assert.deepEqual(after.map(({definition,...rest})=>rest),before.map(({definition,...rest})=>rest),'Surgical hooks preserve OIDs, ownership, ACLs, security and search paths');
  assert.ok(after.find(x=>x.proname==='warpcore_shadow_select_run').definition.includes("settings.policy_version is distinct from '2026-11-21.1'"),'Installed strict current guard is preserved');assert.deepEqual(await q('select * from shadow_agent.runs order by id'),runs,'Installing recovery never resets existing work');
  assert.equal((await q('select public.warpcore_shadow_select_run() v'))[0].v,null);assert.equal((await q('select public.warpcore_verification_claim() v'))[0].v.jobId,f.job,'Patched installed selector/claim execute normal recovery');
 }finally{await db.close();}
}
console.log('PASS exact source/migration parity, strict live guard and OID/ACL preservation, runtime hooks, and unknown-shape transactional refusal');
