// Real independent PostgreSQL sessions; dedicated local fixture only, no hosted access.
import {Client} from 'pg';import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=Array.from({length:7},()=>new Client({connectionString:url.href}));const writers=clients.slice(0,6),a=writers[0],observer=clients[6];
const account='did:plc:batchtestabcdefghijklmn',record=n=>n%2?{$type:'app.bsky.feed.repost',subject:{uri:'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3n256uxsaokol',cid:'bafyre'+'a'.repeat(53)},createdAt:'2026-11-12T12:00:00.000Z'}:{$type:'app.bsky.feed.post',text:'Synthetic concurrency fixture',createdAt:'2026-11-12T12:00:00.000Z'};
const args=n=>[account,createHash('sha256').update('batch-budget-story-'+n).digest('hex'),'hash',record(n)];
const claim=(c,n)=>c.query('select * from warpcore_claim_publication($1,$2,$3,$4)',args(n));
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='15s'")));
 if((await a.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n===0){await a.query('create role anon;create role authenticated;create role service_role bypassrls;');await a.query(await fs.readFile(new URL('../supabase/migrations/20261112145946_warpcore_review_base.sql',import.meta.url),'utf8'));}
 if(!(await a.query("select to_regclass('public.warpcore_publication_slots') present")).rows[0].present)await a.query(await fs.readFile(new URL('../supabase/migrations/20261112190000_warpcore_publication_hour_guard.sql',import.meta.url),'utf8'));
 if(!(await a.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='warpcore_publication_slots' and column_name='attempts') present")).rows[0].present)await a.query(await fs.readFile(new URL('../supabase/migrations/20261112201145_warpcore_hourly_batch_budget.sql',import.meta.url),'utf8'));
 for(let n=1;n<=6;n++){await a.query("insert into warpcore_stories(story_key,status) values($1,'approved')",[args(n)[1]]);await a.query('select warpcore_prepare_publication($1,$2,$3,$4,$5)',[...args(n),'test-batch-'+n]);await a.query('select warpcore_review_publication($1,$2,$3,$4,true)',args(n));}
 const pids=(await Promise.all(writers.slice(1).map(c=>c.query('select pg_backend_pid() pid')))).map(r=>r.rows[0].pid);
 await a.query('begin');assert.equal((await claim(a,1)).rowCount,1);
 const competing=writers.slice(1).map((c,i)=>claim(c,i+2));let allBlocked=false;
 for(let i=0;i<80;i++){const activity=await observer.query("select count(*)::int n from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",[pids]);if(activity.rows[0].n===5){allBlocked=true;break;}await new Promise(r=>setTimeout(r,25));}
 assert.equal(allBlocked,true,'All five different-story sessions actually contend on account budget lock');await a.query('commit');
 const results=await Promise.all(competing);assert.equal(results.reduce((sum,r)=>sum+r.rowCount,1),5,'Only five out of six concurrent claims succeed');
 assert.equal((await a.query("select count(*)::int n from warpcore_publications where account_did=$1 and state='sending'",[account])).rows[0].n,5);
 assert.equal((await a.query('select attempts from warpcore_publication_slots where account_did=$1',[account])).rows[0].attempts,5);
 const denied=results.findIndex(r=>r.rowCount===0)+2;assert.equal((await a.query('select state from warpcore_publications where account_did=$1 and story_key=$2',[account,args(denied)[1]])).rows[0].state,'prepared');
 assert.equal((await claim(a,1)).rowCount,0,'Same-story replay does not spend another attempt');assert.equal((await claim(a,denied)).rowCount,0,'Sixth story remains capped');assert.equal((await a.query('select attempts from warpcore_publication_slots where account_did=$1',[account])).rows[0].attempts,5);
 console.log('PASS: six genuinely concurrent mixed post/repost sessions yield exactly five attempts; replay and excess claim consume nothing');
}finally{await Promise.all(clients.map(c=>c.query('rollback').catch(()=>{})));await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
