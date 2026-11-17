// Disposable stubs only: no network or extension installation.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
const sql=await fs.readFile(new URL('../supabase/schedules/install-agent-disabled.sql',import.meta.url),'utf8');
const q=async s=>(await db.query(s)).rows;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema shadow_agent;grant usage on schema shadow_agent to anon,authenticated,service_role;create table shadow_agent.producer_settings(singleton boolean default true,enabled boolean);insert into shadow_agent.producer_settings(enabled) values(false);
 create table shadow_agent.ranking_runs(id int);create table shadow_agent.selection_items(id int);
 create schema cron;create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text,active boolean default true);
 create function cron.schedule(text,text,text) returns bigint language sql as 'insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid';
 create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
 create schema net;create table net.queue(url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds int);
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language sql as 'insert into net.queue values($1,$2,$3,$4,$5) returning 1::bigint';
 revoke all on function cron.schedule(text,text,text) from public;
 insert into cron.job(jobname,schedule,command) values('existing-publisher','*/5 * * * *','select 1');`);
 await assert.rejects(()=>db.exec(sql),/extensions/);await db.exec('rollback');
 // PGlite cannot install pg_cron/pg_net/Vault. Replace ONLY catalog prerequisite
 // predicate with true; production SQL retains pg_extension guard unchanged.
 const fixture=sql.replace("(select count(*) from pg_catalog.pg_extension where extname in ('pg_cron','pg_net','supabase_vault')) <> 3",'false');
 for(const grant of ['grant execute on function cron.schedule(text,text,text) to service_role','grant select on vault.decrypted_secrets to anon','grant update on cron.job to authenticated']){
  await db.exec(grant);await assert.rejects(()=>db.exec(fixture),/privileges require review/);await db.exec('rollback');
  await db.exec(grant.replace('grant ','revoke ').replace(' to ',' from '));
 }
 await db.exec(fixture);
 assert.equal((await q('select count(*)::int n from net.queue'))[0].n,0);
 assert.deepEqual(await q('select jobname,active from cron.job order by jobid'),[{jobname:'existing-publisher',active:true},{jobname:'warpcore-news-agent-continuation',active:false}]);
 await assert.rejects(()=>db.exec(fixture),/already installed/);await db.exec('rollback');assert.equal((await q('select count(*)::int n from cron.job'))[0].n,2);
 await q('select shadow_agent.enqueue_continuation()');assert.equal((await q('select count(*)::int n from net.queue'))[0].n,0);
 await db.exec("update shadow_agent.producer_settings set enabled=true");
 await assert.rejects(()=>q('select shadow_agent.enqueue_continuation()'),/configuration/);
 await db.exec("update shadow_agent.scheduler_settings set approved_project_origin='https://fixture.supabase.co'; insert into vault.decrypted_secrets values ('warpcore_agent_project_url','https://fixture.supabase.co'),('warpcore_agent_gateway_anon_jwt','"+'a'.repeat(40)+"'),('warpcore_agent_cron_token','"+'b'.repeat(40)+"')");
 await q('select shadow_agent.enqueue_continuation()');
 assert.deepEqual(await q('select * from net.queue'),[{url:'https://fixture.supabase.co/functions/v1/news-agent',body:{},params:{},headers:{'Content-Type':'application/json',Authorization:'Bearer '+'a'.repeat(40),'x-warpcore-agent-token':'b'.repeat(40)},timeout_milliseconds:120000}]);
 await db.exec('truncate net.queue');
 const mutations=[];
 for(const name of ['warpcore_agent_project_url','warpcore_agent_gateway_anon_jwt','warpcore_agent_cron_token']){
  mutations.push(`delete from vault.decrypted_secrets where name='${name}'`, `insert into vault.decrypted_secrets select * from vault.decrypted_secrets where name='${name}'`, `update vault.decrypted_secrets set decrypted_secret='short' where name='${name}'`);
 }
 mutations.push("update vault.decrypted_secrets set decrypted_secret='https://other.supabase.co' where name='warpcore_agent_project_url'", "update vault.decrypted_secrets set decrypted_secret=repeat('a',40) where name='warpcore_agent_cron_token'");
 for(const mutation of mutations){
  await db.exec('begin');await db.exec(mutation);await assert.rejects(()=>q('select shadow_agent.enqueue_continuation()'),/configuration/);await db.exec('rollback');
 }
 assert.equal((await q('select count(*)::int n from net.queue'))[0].n,0);
 for(const role of ['anon','authenticated','service_role']){assert.equal((await q(`select has_table_privilege('${role}','shadow_agent.scheduler_settings','select,insert,update,delete') as permitted`))[0].permitted,false);await db.exec(`set role ${role}`);await assert.rejects(()=>q('select shadow_agent.enqueue_continuation()'),/permission denied/);await assert.rejects(()=>q('select * from shadow_agent.scheduler_settings'),/permission denied/);await db.exec('reset role');}
 console.log('PASS: inactive atomic scheduler, exact private enqueue, secret/origin refusal and worker permissions');
}finally{await db.close();}
