import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
const migration=await fs.readFile(new URL('../supabase/migrations/20261118210000_warpcore_agent_news_sources.sql',import.meta.url),'utf8');
const db=new PGlite();try{
 await db.exec(`create schema shadow_agent;create table shadow_agent.runs(state jsonb);
 create table shadow_agent.producer_settings(singleton boolean,policy_version text);insert into shadow_agent.producer_settings values(true,'2026-11-18.1');
 create table shadow_agent.runtime_settings(singleton boolean,allowed_source_hosts text[]);insert into shadow_agent.runtime_settings values(true,array['github.com','openai.com']);
 create function public.warpcore_shadow_select_run() returns text language sql as $$select '2026-11-18.1'$$;
 create function shadow_agent.create_validation_run(text,numeric) returns text language sql as $$select '2026-11-18.1'$$;
 insert into shadow_agent.runs values('{"storageKind":"paged-v1","phase":"review"}');`);
 await assert.rejects(db.exec(migration),/Drain discovery/);await db.exec('rollback;delete from shadow_agent.runs;');
 await db.exec(migration);
 assert.equal((await db.query('select public.warpcore_shadow_select_run() v')).rows[0].v,POLICY_VERSION);
 assert.equal((await db.query('select policy_version from shadow_agent.producer_settings')).rows[0].policy_version,POLICY_VERSION);
 assert.equal((await db.query("select shadow_agent.create_validation_run('fixture',1) v")).rows[0].v,POLICY_VERSION);
 const hosts=(await db.query('select allowed_source_hosts from shadow_agent.runtime_settings')).rows[0].allowed_source_hosts;
 for(const host of ['github.com','openai.com','api-docs.deepseek.com','openclaw.ai','earendil.com','blog.jetbrains.com','www.infoq.com','www.esa.int','spacenews.com','www.virgingalactic.com','x.ai'])assert.ok(hosts.includes(host),host);
 console.log('PASS agent-news migration: active scans fenced; versions agree; verification hosts merged');
}finally{await db.close();}
