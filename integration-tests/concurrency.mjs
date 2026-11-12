import {Client} from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL ?? '');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=[new Client({connectionString:url.toString()}),new Client({connectionString:url.toString()}),new Client({connectionString:url.toString()})];
const [a,b,observer]=clients;
try{
 await Promise.all(clients.map(c=>c.connect()));
 await Promise.all(clients.map(c=>c.query("set statement_timeout='10s'")));
 assert.equal((await a.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n,0,'Test DB must be empty');
 await a.query('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const p of ['warpcore-schema-proposal.sql','warpcore-publication-ledger-proposal.sql','warpcore-operator-proposal.sql','warpcore-rate-guard.sql'])await a.query(await fs.readFile(new URL('../docs/'+p,import.meta.url),'utf8'));
 const key='b'.repeat(64),did='did:plc:abcdefghijklmnopqrstuvwx',record=JSON.stringify({text:'synthetic',createdAt:'2026-11-12T12:00:00Z'}),args=[did,key,'hash',record];
 await a.query("insert into warpcore_stories(story_key,status) values ($1,'approved')",[key]);
 await a.query('select warpcore_prepare_publication($1,$2,$3,$4::jsonb,$5)',[...args,'story-test']);
 await a.query('update warpcore_publications set approved_at=now()');
 await a.query('begin');assert.equal((await a.query('select * from warpcore_claim_publication($1,$2,$3,$4::jsonb)',args)).rowCount,1);
 const pid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;
 const second=b.query('select * from warpcore_claim_publication($1,$2,$3,$4::jsonb)',args);
 let blocked=false;for(let i=0;i<40;i++){const r=await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid]);if(r.rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(blocked,true,'second session must actually contend on first transaction');
 await a.query('commit');assert.equal((await second).rowCount,0,'loser rechecks prepared state after lock');

 await a.query('begin');
 assert.equal((await a.query('select warpcore_reserve_login($1) as ok',[did])).rows[0].ok,true);
 const loginLoser=b.query('select warpcore_reserve_login($1) as ok',[did]);
 let loginBlocked=false;for(let i=0;i<40;i++){const r=await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid]);if(r.rows[0]?.wait_event_type==='Lock'){loginBlocked=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(loginBlocked,true,'login reservation must actually contend');
 await a.query('commit');assert.equal((await loginLoser).rows[0].ok,false,'second login reservation denied');
 console.log('PASS: independent sessions observed publication and login lock contention; exactly one claimant each');

}finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
