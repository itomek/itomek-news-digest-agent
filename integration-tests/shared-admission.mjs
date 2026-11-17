// Disposable PostgreSQL fixtures only; no HTTP/model/publishing.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const sql=await fs.readFile(new URL('../supabase/functions/news-agent/sql/shared-admission.sql',import.meta.url),'utf8');
const db=new PGlite();const q=async(s,args=[])=>(await db.query(s,args)).rows;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.warpcore_curator_inbox(story_key text primary key,state text not null check(state in ('pending','leased','processed','rejected')));
 create table public.warpcore_publications(account_did text default 'pinned',story_key text,state text not null check(state in ('prepared','sending','uncertain','published','rejected','manual_review')),primary key(account_did,story_key));
 grant select,insert,update on public.warpcore_curator_inbox,public.warpcore_publications to service_role;
 insert into public.warpcore_curator_inbox select n::text,'pending' from generate_series(1,6)n;`);
 await assert.rejects(()=>db.exec(sql),/existing combined pending count 6/);await db.exec('rollback');
 assert.equal((await q('select count(*)::int n from warpcore_curator_inbox'))[0].n,6);
 assert.equal((await q("select to_regnamespace('warpcore_admission') is null absent"))[0].absent,true);
 await db.exec("update warpcore_curator_inbox set state='rejected' where story_key='6'");
 await db.exec(sql);
 await db.exec('set role service_role');
 await assert.rejects(()=>q("insert into warpcore_publications(story_key,state) values ('7','prepared')"),/Combined pending limit/);
 await assert.rejects(()=>q("insert into warpcore_curator_inbox values ('7','pending')"),/Combined pending limit/);
 await db.exec("begin;update warpcore_curator_inbox set state='leased' where story_key='1';insert into warpcore_publications(story_key,state) values ('1','prepared');update warpcore_curator_inbox set state='processed' where story_key='1';commit;");
 for(const state of ['sending','uncertain','manual_review'])await q('update warpcore_publications set state=$1 where story_key=$2',[state,'1']);
 await assert.rejects(()=>q("insert into warpcore_publications(story_key,state) values ('7','prepared')"),/Combined pending limit/);
 await q("update warpcore_publications set state='published' where story_key='1'");
 await q("insert into warpcore_publications(story_key,state) values ('7','prepared') on conflict do nothing");
 await q("insert into warpcore_publications(story_key,state) values ('7','prepared') on conflict do nothing");
 await assert.rejects(()=>q("insert into warpcore_publications(story_key,state) values ('8','prepared'),('9','uncertain')"),/Combined pending limit/);
 assert.equal((await q("select count(*)::int n from warpcore_publications where story_key in ('8','9')"))[0].n,0);
 await q("update warpcore_curator_inbox set state='rejected' where story_key='2'");
 await q("insert into warpcore_curator_inbox values ('8','pending')");
 await assert.rejects(()=>q("update warpcore_curator_inbox set state='pending' where story_key='6'"),/Combined pending limit/);
 await db.exec('reset role');
 await db.exec('begin isolation level repeatable read');await assert.rejects(()=>q("insert into warpcore_publications(story_key,state) values ('10','prepared')"),/READ COMMITTED/);await db.exec('rollback');
 for(const role of ['anon','authenticated','service_role']){
  assert.equal((await q(`select has_schema_privilege('${role}','warpcore_admission','usage') allowed`))[0].allowed,false);
  assert.equal((await q(`select has_function_privilege('${role}','warpcore_admission.assert_limit()','execute') allowed`))[0].allowed,false);
 }
 console.log('PASS: combined global five-story admission, same-story transfer, all unresolved states, bulk rollback, idempotence, terminal progress, install refusal and private helpers');
}finally{await db.close();}
