// Independent PostgreSQL sessions, exclusively disposable loopback fixture.
import {Client} from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'http://invalid');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!='/warpcore_test'||url.search||url.hash)throw Error('Disposable loopback warpcore_test required');
const clients=Array.from({length:3},()=>new Client({connectionString:url.href}));const [a,b,c]=clients;
const q=(client,sql,args=[])=>client.query(sql,args);let owned=false;
try{
 await Promise.all(clients.map(x=>x.connect()));await Promise.all(clients.map(x=>q(x,"set statement_timeout='5s'")));
 assert.equal((await q(c,"select to_regclass('public.warpcore_curator_inbox') is null and to_regclass('public.warpcore_publications') is null and to_regnamespace('warpcore_admission') is null absent")).rows[0].absent,true,'Refuse existing fixture');
 await q(c,`do $$declare role_name text;begin foreach role_name in array array['anon','authenticated','service_role'] loop if not exists(select 1 from pg_roles where rolname=role_name) then execute format('create role %I',role_name);end if;end loop;end $$;
 create table public.warpcore_curator_inbox(story_key text primary key,state text not null check(state in ('pending','leased','processed','rejected')));
 create table public.warpcore_publications(story_key text primary key,state text not null check(state in ('prepared','sending','uncertain','manual_review','published','rejected')));
 insert into public.warpcore_curator_inbox select n::text,'pending' from generate_series(1,4)n;`);owned=true;
 await q(c,await fs.readFile(new URL('../supabase/functions/news-agent/sql/shared-admission.sql',import.meta.url),'utf8'));
 await q(a,'begin');await q(a,"insert into warpcore_publications values('5','prepared')");
 await q(b,'begin');const start=Date.now();await assert.rejects(()=>q(b,"insert into warpcore_curator_inbox values('6','pending')"),e=>e.code==='55P03');assert.ok(Date.now()-start<2000,'Contention refuses without waiting');await q(b,'rollback');await q(a,'commit');
 // Fresh READ COMMITTED statement must see the first committed fifth story.
 await assert.rejects(()=>q(b,"insert into warpcore_curator_inbox values('6','pending')"),/Combined pending limit/);
 assert.equal((await q(c,"select count(*)::int n from (select story_key from warpcore_curator_inbox where state in ('pending','leased') union select story_key from warpcore_publications where state in ('prepared','sending','uncertain','manual_review'))x")).rows[0].n,5);
 // Existing legacy row lock must not deadlock against the global admission lock.
 await q(b,'begin');await q(b,"select * from warpcore_curator_inbox where story_key='1' for update");
 await q(a,'begin');await q(a,"update warpcore_publications set state='sending' where story_key='5'");
 const pid=(await q(a,'select pg_backend_pid() pid')).rows[0].pid;
 const waiting=q(a,"update warpcore_curator_inbox set state='leased' where story_key='1'").then(value=>({value}),error=>({error}));
 let blocked=false;for(let i=0;i<80;i++){if((await q(c,"select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(blocked,true,'Observe actual legacy row-lock wait before inversion refusal');
 await assert.rejects(()=>q(b,"update warpcore_curator_inbox set state='leased' where story_key='2'"),e=>e.code==='55P03');await q(b,'rollback');assert.equal((await waiting).error,undefined);await q(a,'commit');
 // Transfer at capacity does not transiently double-count one story.
 await q(a,'begin');await q(a,"insert into warpcore_publications values('1','prepared')");await q(a,"update warpcore_curator_inbox set state='processed' where story_key='1'");await q(a,'commit');
 // Reverse writer order and rollback release both admission lock and capacity.
 await q(a,'begin');await q(a,"update warpcore_publications set state='published' where story_key='5'");await q(a,"insert into warpcore_curator_inbox values('6','pending')");
 await assert.rejects(()=>q(b,"insert into warpcore_publications values('7','prepared')"),e=>e.code==='55P03');await q(a,'rollback');
 await assert.rejects(()=>q(b,"insert into warpcore_publications values('7','prepared')"),/Combined pending limit/);
 assert.equal((await q(c,"select count(*)::int n from warpcore_curator_inbox where story_key='6'")).rows[0].n,0);
 console.log('PASS: real PostgreSQL near-capacity writers, immediate 55P03, post-commit snapshot, legacy row-lock inversion, capacity transfer and rollback');
}finally{
 await Promise.allSettled(clients.map(x=>q(x,'rollback')));
 if(owned)await q(c,'drop table public.warpcore_curator_inbox,public.warpcore_publications;drop schema warpcore_admission cascade;');
 await Promise.allSettled(clients.map(x=>x.end()));
}
