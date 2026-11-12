// Standalone: dedicated loopback fixture database only. Does not touch hosted data.
import {Client} from 'pg';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=Array.from({length:3},()=>new Client({connectionString:url.toString()}));const [a,b,observer]=clients;
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='10s'")));
 const empty=(await a.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n===0;
 if(empty){
  await a.query('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const name of ['warpcore-schema-proposal.sql','warpcore-publication-ledger-proposal.sql','warpcore-operator-proposal.sql'])await a.query(await fs.readFile(new URL('../docs/'+name,import.meta.url),'utf8'));
 }
 // Existing CI schema is permitted only in the explicitly named loopback test DB.
 if(!(await a.query("select to_regclass('public.warpcore_publication_slots') present")).rows[0].present)
 await a.query(await fs.readFile(new URL('../supabase/migrations/20261112190000_warpcore_publication_hour_guard.sql',import.meta.url),'utf8'));
 const account='did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',record=JSON.stringify({text:'synthetic',createdAt:'2026-11-12T12:00:00Z'}),args=n=>[account,String(n+7).repeat(64),'hash',record];
 for(const n of [1,2]){await a.query("insert into warpcore_stories(story_key,status) values($1,'approved')",[args(n)[1]]);await a.query('select warpcore_prepare_publication($1,$2,$3,$4::jsonb,$5)',[...args(n),`story-${n}`]);await a.query('select warpcore_review_publication($1,$2,$3,$4::jsonb,true)',args(n));}
 const claim=(client,n)=>client.query('select * from warpcore_claim_publication($1,$2,$3,$4::jsonb)',args(n));
 await a.query('begin');assert.equal((await claim(a,1)).rowCount,1);
 const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
 const loser=claim(b,2);let blocked=false;
 for(let i=0;i<40;i++){if((await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(blocked,true,'different-story claimant must contend on account slot');
 await a.query('commit');assert.equal((await loser).rowCount,0,'only one story claims the account hour');
 assert.equal((await a.query("select count(*)::int n from warpcore_publications where state='sending' and account_did='did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'")).rows[0].n,1);
 assert.equal((await a.query("select state from warpcore_publications where story_key=$1",[args(2)[1]])).rows[0].state,'prepared');
 console.log('PASS: independent different-story sessions contend; only one send claim per account hour');
}finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
