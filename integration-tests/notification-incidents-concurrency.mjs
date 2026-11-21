// Independent sessions, dedicated disposable loopback database only.
import {Client} from 'pg';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=Array.from({length:3},()=>new Client({connectionString:url.href}));const[a,b,observer]=clients;
const observe=(c,classes,resolved=[])=>c.query('select warpcore_notification_observe($1,$2,$3,$4::jsonb,$5::jsonb) r',['source','fixture:notification-race','a'.repeat(64),JSON.stringify(classes),JSON.stringify(resolved)]);
const claim=async c=>(await c.query('select warpcore_notification_claim() r')).rows[0].r;
const ack=async(c,s)=>(await c.query("select warpcore_notification_ack($1,$2,'sent') r",[s.id,s.token])).rows[0].r;
let pid;
async function blocked(){for(let i=0;i<80;i++){if((await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return true;await new Promise(r=>setTimeout(r,25));}return false;}
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='10s'")));pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
 await a.query(await fs.readFile(new URL('../supabase/functions/news-agent/sql/notification-incidents.sql',import.meta.url),'utf8'));
 await a.query('truncate warpcore_private.notification_incidents');
 await a.query('begin');await observe(a,['source_network']);const competing=observe(b,['source_network']);assert.equal(await blocked(),true,'observation admission actually contends');await a.query('commit');await competing;
 await a.query('begin');const first=await claim(a);assert.ok(first);assert.equal(await claim(b),null,'skip locked prevents concurrent send');await a.query('commit');assert.equal(await claim(b),null,'committed claim suppresses replay');
 // Recovery fences an in-flight failed-incident sender.
 await observe(b,[],['source_network']);assert.equal(await ack(a,first),false);
 const recovery=await claim(b);assert.equal(recovery.event,'recovered');
 await observe(a,['source_network']);assert.equal(await ack(b,recovery),false,'reopen fences stale recovery acceptance');
 const renewed=await claim(a);assert.equal(renewed.event,'opened');assert.equal(renewed.generation,2);assert.equal(await ack(a,renewed),true);
 // Expired claim still waits out uncertainty backoff before takeover.
 await a.query("update warpcore_private.notification_incidents set next_attempt_at=now()-interval '1 second'");const stale=await claim(a);
 await b.query("update warpcore_private.notification_incidents set claim_until=now()-interval '1 second'");assert.equal(await claim(b),null);
 await b.query("update warpcore_private.notification_incidents set next_attempt_at=now()-interval '1 second'");const takeover=await claim(b);assert.ok(takeover);assert.equal(await ack(a,stale),false);assert.equal(await ack(b,takeover),true);
 console.log('PASS: overlapping observation/claim sessions, recovery/reopen fences, uncertainty backoff and lease takeover');
}finally{await Promise.all(clients.map(c=>c.query('rollback').catch(()=>{})));await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
