// Disposable embedded setup test; never connects to a hosted project or model.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
const fixture=await fs.readFile(new URL('../supabase/functions/news-agent-spike/fixture.sql',import.meta.url),'utf8');
const db=new PGlite(),q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(fixture);
 const tables=(await q("select tablename from pg_tables where schemaname='public' order by tablename")).map(r=>r.tablename);
 assert.deepEqual(tables,['warpcore_candidates','warpcore_curator_inbox','warpcore_publications','warpcore_stories']);
 assert.equal((await q('select count(*)::integer as n from public.warpcore_stories'))[0].n,405);
 assert.equal((await q('select count(*)::integer as n from public.warpcore_candidates'))[0].n,405);
 assert.equal((await q("select count(distinct source_type)::integer as n from public.warpcore_candidates"))[0].n,1);
 assert.equal((await q("select count(*)::integer as n from public.warpcore_candidates c join public.warpcore_stories s using(story_key) where c.source_url like 'https://example.com/%' and c.text like 'SYNTHETIC NONPUBLISHING SPIKE%' and s.collected_at=c.collected_at and c.collected_at<=clock_timestamp()-interval '59 seconds' and c.fixture_kind='synthetic-nonpublishing-spike-v1'"))[0].n,405);
 assert.equal((await q("select count(*)::integer as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"))[0].n,0);
 for(const table of tables){
  assert.equal((await q('select relrowsecurity as enabled from pg_class where oid=$1::regclass',[`public.${table}`]))[0].enabled,true);
  for(const role of ['anon','authenticated','service_role']){
   await db.exec(`set role ${role}`);
   assert.equal((await q("select has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed",[`public.${table}`]))[0].allowed,false);
   await assert.rejects(()=>q(`select * from public.${table}`),/permission denied/);
   await assert.rejects(()=>q(`delete from public.${table}`),/permission denied/);
   await db.exec('reset role');
  }
 }
 for(const table of ['warpcore_curator_inbox','warpcore_publications']){
  assert.equal((await q(`select count(*)::integer as n from public.${table}`))[0].n,0);
  await assert.rejects(()=>q(`insert into public.${table}(story_key) values ($1)`,['a'.repeat(64)]),/check constraint/);
 }
 await assert.rejects(()=>db.exec(fixture),/Refusing spike fixture install/);await db.exec('rollback');
 assert.equal((await q('select count(*)::integer as n from public.warpcore_stories'))[0].n,405);
 for(const name of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${name}`,import.meta.url),'utf8'));
 assert.equal((await q('select enabled from shadow_agent.producer_settings'))[0].enabled,false);
 assert.equal((await q('select count(*)::integer as n from shadow_agent.budgets'))[0].n,0,'Fixture must not authorize spending');
 // Synthetic accounting values are test-only administrative setup, not real money.
 await q("insert into shadow_agent.budgets(day,limit_credits) values ((clock_timestamp() at time zone 'utc')::date,0.5)");
 await q('update shadow_agent.producer_settings set enabled=true,run_limit_credits=0.2,policy_version=$1',[POLICY_VERSION]);
 await db.exec('set role service_role');
 const run=await scalar('select public.warpcore_shadow_select_run() as value');assert.ok(run);
 const state=await scalar('select public.warpcore_shadow_load($1) as value',[run]);assert.equal(state.publishingEnabled,false);
 let cursor=null;const all=[],sizes=[];
 for(;;){const page=await scalar('select public.warpcore_shadow_candidate_page($1,$2) as value',[state.scanStartedAt,cursor]);sizes.push(page.length);if(!page.length)break;all.push(...page);cursor=page.at(-1).story_key;}
 assert.deepEqual(sizes,[100,100,100,100,5,0]);assert.equal(all.length,405);assert.equal(all.at(-1).story_key,(405).toString(16).padStart(64,'0'));
 await db.exec('reset role');
 assert.equal((await q('select count(*)::integer as n from shadow_agent.attempts'))[0].n,0);
 for(const table of ['warpcore_curator_inbox','warpcore_publications'])assert.equal((await q(`select count(*)::integer as n from public.${table}`))[0].n,0);
 console.log('PASS: synthetic 405-story fixture, private RLS tables, empty publication boundary and complete RPC candidate scan; no model or network');
}finally{await db.close();}
for(const preexisting of ['create table public.warpcore_existing(id integer)','create schema shadow_agent']){
 const dirty=new PGlite();
 try{
  await dirty.exec('create role anon;create role authenticated;create role service_role;');await dirty.exec(preexisting);
  await assert.rejects(()=>dirty.exec(fixture),/Refusing spike fixture install/);await dirty.exec('rollback');
  assert.equal((await dirty.query("select to_regclass('public.warpcore_stories') as value")).rows[0].value,null);
 }finally{await dirty.close();}
}

console.log('PASS: refused existing Warp Core relations/shadow schema without overwriting fixtures');
