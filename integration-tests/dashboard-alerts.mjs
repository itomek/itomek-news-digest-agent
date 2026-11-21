// Disposable SQL: authenticated fixed alert copy, never private operator data.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows;
const read=async()=>(await q('select public.warpcore_agent_active_alerts() value'))[0].value;
const newCodes=['source_head_stale','verification_stalled','publication_stalled','curation_stalled'];
const codes=[...newCodes,'discovery_stalled','source_attempt_outage','source_failed','budget_unavailable','accounting_uncertain','verification_uncertain','publication_reconciliation','handoff_deferred','handoff_stalled','scheduler_http_failure','scheduler_response_unavailable','scheduler_enqueue_failed','lifetime_headroom_exhausted','queue_above_limit'];
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema shadow_agent;
 create table shadow_agent.alert_settings(singleton boolean primary key,enabled boolean,private_key text);
 create table shadow_agent.alert_state(code text primary key,active boolean,affected_count bigint,changed_at timestamptz,private_details jsonb);
 revoke all on schema shadow_agent from public,anon,authenticated,service_role;
 insert into shadow_agent.alert_settings values(true,false,'PRIVATE KEY');`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/dashboard-alerts.sql',import.meta.url),'utf8'));
 for(const code of codes)await q("insert into shadow_agent.alert_state values($1,true,3,now(),$2)",[code,{id:'secret-run-id',url:'https://private.example/',prompt:'PRIVATE PROMPT',budget:1234}]);
 assert.deepEqual(await read(),[],'Disabled private alert delivery returns no dashboard rows');
 await db.exec('set role anon');await assert.rejects(read,/permission/);await db.exec('reset role');
 await db.exec('update shadow_agent.alert_settings set enabled=true');
 const expected=await read();assert.equal(expected.length,15);assert.ok(expected.length<=15);
 for(const item of expected){assert.deepEqual(Object.keys(item).sort(),['affectedCount','changedAt','code','message']);assert.ok(codes.includes(item.code));assert.equal(item.affectedCount,3);assert.ok(Number.isFinite(Date.parse(item.changedAt)));assert.ok(item.message.length>0);assert.equal(item.message.includes(item.code),false);assert.doesNotMatch(item.message,/_|https:|PRIVATE|1234/);}
 assert.equal(new Set(expected.map(x=>x.message)).size,15,'Bounded alerts have distinct friendly copy');
 assert.doesNotMatch(JSON.stringify(expected),/PRIVATE|secret-run-id|private.example|1234/);
 for(const code of newCodes){
  await q('update shadow_agent.alert_state set active=(code=$1)',[code]);
  const rows=await read();assert.equal(rows.length,1,code+' is projected');assert.equal(rows[0].code,code);assert.deepEqual(Object.keys(rows[0]).sort(),['affectedCount','changedAt','code','message']);assert.ok(rows[0].message.length>0);assert.equal(rows[0].message.includes(code),false);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|secret-run-id|private.example|1234|<script/);
 }
 await q('update shadow_agent.alert_state set active=true');
 await q("update shadow_agent.alert_state set active=false where code='source_failed'");assert.equal((await read()).some(x=>x.code==='source_failed'),false);
 // Future/unrecognized private state cannot spill raw data into this fixed API.
 for(let i=0;i<30;i++)await q('insert into shadow_agent.alert_state values($1,true,1,now(),null)',['PRIVATE_UNKNOWN_'+i]);
 assert.equal((await read()).length,15);
 await q("update shadow_agent.alert_state set affected_count=9007199254740993 where code='queue_above_limit'");assert.equal((await read()).find(x=>x.code==='queue_above_limit').affectedCount,2147483647);
 for(const role of ['authenticated','service_role']){await db.exec('set role '+role);assert.equal((await read()).length,15);await assert.rejects(()=>q('select * from shadow_agent.alert_state'),/permission/);await assert.rejects(()=>q('update shadow_agent.alert_settings set enabled=true'),/permission/);await db.exec('reset role');}
 await db.exec('update shadow_agent.alert_state set active=false');assert.deepEqual(await read(),[]);
 console.log('PASS: authenticated/service-only bounded active alert RPC, disabled no-op, fixed friendly copy, no private details and no worker settings authority');
}finally{await db.close();}
