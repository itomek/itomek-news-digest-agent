import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();const q=async sql=>(await db.query(sql)).rows;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema shadow_agent;
 create table shadow_agent.producer_settings(enabled boolean,singleton boolean default true);insert into shadow_agent.producer_settings(enabled) values(true);
 create table public.warpcore_curator_inbox(id integer,state text);
 create table public.warpcore_publications(id integer,state text);
 create table shadow_agent.verification_jobs(status text,handoff_status text,quarantined boolean);
 create table shadow_agent.runs(blocked boolean,state jsonb);
 create table shadow_agent.fixture(waiting integer,calls integer);insert into shadow_agent.fixture values(0,0);
 create function shadow_agent.queue_summary() returns jsonb language sql as $$select jsonb_build_object('waiting',waiting) from shadow_agent.fixture$$;
 create function shadow_agent.next_verification_candidate() returns setof integer language sql as $$select 1 where false$$;
 create function shadow_agent.alerting_enqueue() returns bigint language sql as $$update shadow_agent.fixture set calls=calls+1 returning calls::bigint$$;`);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261118162528_warpcore_worker_continuation.sql',import.meta.url),'utf8'));
 const calls=async()=>(await q('select calls from shadow_agent.fixture'))[0].calls;
 assert.equal(await calls(),0,'installation never dispatches');
 await q('select public.warpcore_worker_continue()');assert.equal(await calls(),0,'empty queue sleeps');
 await q('update shadow_agent.fixture set waiting=19');await q('select public.warpcore_worker_continue()');assert.equal(await calls(),1);
 await q("insert into warpcore_publications values(1,'sending')");await q('select public.warpcore_worker_continue()');assert.equal(await calls(),1,'in-flight publication waits for terminal event');
 await q("update warpcore_publications set state='published'");assert.equal(await calls(),2,'published immediately wakes remaining work, same minute');
 await q("update warpcore_publications set state='published'");assert.equal(await calls(),2,'no-op terminal update cannot wake twice');
 await q("insert into warpcore_curator_inbox values(1,'pending')");await q('select public.warpcore_worker_continue()');assert.equal(await calls(),2);
 await q("update warpcore_curator_inbox set state='rejected'");assert.equal(await calls(),3,'rejected item cannot strand next item');
 await q('update shadow_agent.producer_settings set enabled=false');await q('select public.warpcore_worker_continue()');assert.equal(await calls(),3,'maintenance suppresses continuation');
 await q('update shadow_agent.producer_settings set enabled=true');await q('update shadow_agent.fixture set waiting=0');await q('select public.warpcore_worker_continue()');assert.equal(await calls(),3,'drained queue stops');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>q('select public.warpcore_worker_continue()'),/permission/);await db.exec('reset role');}
 await db.exec('set role service_role');await q('select public.warpcore_worker_continue()');await db.exec('reset role');
 console.log('PASS worker continuation: real SQL terminal transitions wake next item; empty/in-flight/disabled no spin; unchanged terminal state idempotent; private ACL');
}finally{await db.close();}
