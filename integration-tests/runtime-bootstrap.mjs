// Disposable Vault/producer fixtures only; no actual keys or network.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();const q=async(s,a=[])=>(await db.query(s,a)).rows;const value=async(s)=>(await q(s))[0].v;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema shadow_agent;grant usage on schema shadow_agent to service_role;
 create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean not null);insert into shadow_agent.producer_settings values(true,false);
 create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/runtime-bootstrap.sql',import.meta.url),'utf8'));
 const authorization=()=>value('select public.warpcore_agent_authorization() v');const config=()=>value('select public.warpcore_agent_runtime_config() v');
 // Drop Vault entirely: disabled functions must avoid secret lookup.
 await db.exec('drop table vault.decrypted_secrets');assert.deepEqual(await authorization(),{enabled:false});assert.deepEqual(await config(),{enabled:false});
 await db.exec('create table vault.decrypted_secrets(name text,decrypted_secret text);update shadow_agent.producer_settings set enabled=true');
 await assert.rejects(()=>authorization(),/Invalid agent authorization configuration/);await assert.rejects(()=>config(),/Invalid agent runtime configuration/);
 const token='t'.repeat(40),key='synthetic-key-'.repeat(3);
 await q('insert into vault.decrypted_secrets values($1,$2),($3,$4)',['warpcore_agent_cron_token',token,'warpcore_agent_openrouter_key',key]);
 assert.deepEqual(await authorization(),{enabled:true,producerToken:token});await assert.rejects(()=>config(),/configuration/);
 await db.exec("update shadow_agent.runtime_settings set allowed_source_hosts=array['example.com','docs.deno.com']");
 const expected={model:'openai/gpt-oss-120b',apiKey:key,maxOutputTokens:8192,maxCostCredits:0.076596,allowedSourceHosts:['example.com','docs.deno.com']};
 await db.exec('set role service_role');assert.deepEqual(await config(),expected);assert.deepEqual(await authorization(),{enabled:true,producerToken:token});await assert.rejects(()=>q('select * from shadow_agent.runtime_settings'),/permission/);await assert.rejects(()=>q('select * from vault.decrypted_secrets'),/permission/);await db.exec('reset role');
 await assert.rejects(()=>q("update shadow_agent.runtime_settings set model='other/model'"),/check constraint/);
 assert.equal((await q('select model from shadow_agent.runtime_settings'))[0].model,'openai/gpt-oss-120b');
 for(const [model,cap] of [['meta-llama/llama-4-maverick',.216269],['nvidia/nemotron-3.5-super-vl',.157287],['nvidia/nemotron-3-super-120b-a12b',.026215]]){await q('update shadow_agent.runtime_settings set model=$1',[model]);assert.deepEqual(await config(),{...expected,model,maxOutputTokens:4096,maxCostCredits:cap});}await q("update shadow_agent.runtime_settings set model='openai/gpt-oss-120b'");
 for(const name of ['warpcore_agent_cron_token','warpcore_agent_openrouter_key'])for(const mutation of [`delete from vault.decrypted_secrets where name='${name}'`,`insert into vault.decrypted_secrets select * from vault.decrypted_secrets where name='${name}'`,`update vault.decrypted_secrets set decrypted_secret='short' where name='${name}'`,`update vault.decrypted_secrets set decrypted_secret=null where name='${name}'`,`update vault.decrypted_secrets set decrypted_secret=repeat('x',4097) where name='${name}'`,`update vault.decrypted_secrets set decrypted_secret=repeat('x',40)||chr(10) where name='${name}'`]){
  await db.exec('begin');await db.exec(mutation);await assert.rejects(name.endsWith('cron_token')?authorization:config,e=>/Invalid agent (authorization|runtime) configuration/.test(e.message)&&!e.message.includes(key)&&!e.message.includes(token));await db.exec('rollback');
 }
 for(const hosts of [[],['localhost'],['127.0.0.1'],['example.com','example.com'],['EXAMPLE.com'],['https://example.com'],['example.com:443'],['a.internal'],['example.com.']]){
  await db.exec('begin');try{await q('update shadow_agent.runtime_settings set allowed_source_hosts=$1',[hosts]);await assert.rejects(()=>config(),/configuration/);}catch(e){assert.match(e.message,/configuration|check constraint/);}finally{await db.exec('rollback');}
 }
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(authorization,/permission/);await assert.rejects(config,/permission/);await db.exec('reset role');}
 assert.equal((await q("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='shadow_agent' and relname='budgets'"))[0].n,0);
 console.log('PASS: disabled secret-free bootstrap, exact server config, strict private Vault lookup, source-host refusal and service-only grants');
}finally{await db.close();}
