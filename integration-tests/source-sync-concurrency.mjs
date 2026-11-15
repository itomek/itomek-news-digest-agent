// Actual independent sessions and lock observation, disposable loopback database only.
import {Client} from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=Array.from({length:3},()=>new Client({connectionString:url.href}));const[a,b,observer]=clients;
const begin=(c,key='fixture:sync-concurrent')=>c.query('select warpcore_sync_begin($1,$2,$3,$4,$5,$6) r',[key,'rss','fixture','d'.repeat(64),'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z']);
const item={uri:'fixture:sync-concurrent',story_key:'e'.repeat(64),source_type:'rss',source_id:'fixture',actor:'fixture',text:'synthetic',source_created_at:'2026-10-20T00:00:00Z',source_links:[]};
const finish=(c,s,items=[item])=>c.query('select warpcore_sync_finish($1,$2,$3,$4,$5,$6,$7,$8) r',[s.source_key,s.token,JSON.stringify(items),'complete',null,null,null,items.length]);
let pid;
async function blocked(){for(let i=0;i<80;i++){if((await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return true;await new Promise(r=>setTimeout(r,25));}return false;}
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='10s'")));pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
 await a.query(await fs.readFile(new URL('../supabase/migrations/20261115204734_warpcore_source_sync_checkpoints.sql',import.meta.url),'utf8'));
 await a.query('begin');const s=(await begin(a)).rows[0].r;
 const competing=begin(b);assert.equal(await blocked(),true,'begin actually contends on source identity');await a.query('commit');assert.equal((await competing).rows[0].r.acquired,false);
 await a.query('begin');assert.equal((await finish(a,s)).rows[0].r.accepted,true);
 const duplicate=finish(b,s);assert.equal(await blocked(),true,'finish actually contends on checkpoint');await a.query('commit');assert.equal((await duplicate).rows[0].r.accepted,false);
 assert.equal((await a.query('select count(*)::integer n from warpcore_candidates where uri=$1',[item.uri])).rows[0].n,1);
 // Crash before commit: both candidate and success boundary roll back together.
 const crash=(await begin(a,'fixture:sync-crash')).rows[0].r;const crashItem={...item,uri:'fixture:sync-crash'};
 await a.query('begin');await finish(a,crash,[crashItem]);await a.query('rollback');
 assert.equal((await observer.query('select count(*)::integer n from warpcore_candidates where uri=$1',[crashItem.uri])).rows[0].n,0);
 assert.equal((await observer.query('select covered_through from warpcore_source_sync where source_key=$1',[crash.source_key])).rows[0].covered_through,null);
 await a.query("update warpcore_source_sync set lease_until=clock_timestamp()-interval '1 second' where source_key=$1",[crash.source_key]);
 const resumed=(await begin(b,crash.source_key)).rows[0].r;assert.equal((await finish(a,crash,[crashItem])).rows[0].r.accepted,false);
 assert.equal((await finish(b,resumed,[crashItem])).rows[0].r.accepted,true);
 // Crash after commit / lost HTTP response: retry fenced and evidence remains unique.
 assert.equal((await finish(a,resumed,[crashItem])).rows[0].r.accepted,false);
 assert.equal((await observer.query('select count(*)::integer n from warpcore_candidates where uri=$1',[crashItem.uri])).rows[0].n,1);
 console.log('PASS: actual source/finish lock contention; rollback before commit, lease takeover, stale worker and replay after committed success');
}finally{await Promise.all(clients.map(c=>c.query('rollback').catch(()=>{})));await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
