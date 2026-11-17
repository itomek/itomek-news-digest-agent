// Code registry + real SQL profile binding. No budgets, model calls or activation.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {APPROVED_RUNTIME_MODELS,DEFAULT_RUNTIME_MODEL} from '../supabase/functions/news-agent/approved-runtime-models.mjs';
import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,value=async(s,a=[])=>(await q(s,a))[0].v;
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const f of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql'])await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+f,import.meta.url),'utf8'));
 await db.exec('create table shadow_agent.producer_settings(singleton boolean primary key,enabled boolean);insert into shadow_agent.producer_settings values(true,false)');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/runtime-bootstrap.sql',import.meta.url),'utf8'));
 assert.equal((await q('select model from shadow_agent.runtime_settings'))[0].model,DEFAULT_RUNTIME_MODEL);
 for(const approved of APPROVED_RUNTIME_MODELS){
  assert.deepEqual(await value('select shadow_agent.approved_runtime_model($1) v',[approved.model]),approved);
  const run=randomUUID(),state=newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()});await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)',[run,state]);const lease=await value('select shadow_agent.claim($1,120) v',[run]);
  const cfg={model:approved.model,requestProfile:requestProfileForModel(approved.model,approved.discoveryProfileVersion),expectedProvider:approved.provider,maxOutputTokens:4096,maxCostCredits:approved.maxCostCredits,reviewBatchSize:16,timeoutMs:1000,maxResponseBytes:20000,policyVersion:state.policyVersion,routing:'openrouter-no-fallback'};
  assert.ok(cfg.requestProfile,'Reviewed profile version must be installed');if(approved.model==='nvidia/nemotron-3.5-super-vl')assert.equal(cfg.requestProfile.responseFormat,'discovery-keyed-coded-ranking-json-schema-v4');
  if(approved.model.startsWith('nvidia/'))for(const mutate of [x=>x.expectedProvider='Groq',x=>x.maxCostCredits=.058983,x=>x.requestProfile.reasoning={effort:'low'},x=>x.requestProfile.provider.only=['groq'],x=>delete x.requestProfile.reasoning,...(approved.model==='nvidia/nemotron-3.5-super-vl'?[x=>x.requestProfile.responseFormat='discovery-keyed-ranked-json-schema-v3']:[])]){const bad=structuredClone(cfg);mutate(bad);await assert.rejects(()=>value('select shadow_agent.paged_bind_config($1,$2,$3) v',[run,lease,bad]),/Invalid/);}
  if(approved.model==='nvidia/nemotron-3.5-super-vl'){await db.exec('alter function shadow_agent.ranking_bind(uuid) rename to fixture_missing_ranking_bind');await assert.rejects(()=>value('select shadow_agent.paged_bind_config($1,$2,$3) v',[run,lease,cfg]),/Ranking contract required/);await db.exec('alter function shadow_agent.fixture_missing_ranking_bind(uuid) rename to ranking_bind');}
  assert.equal(await value('select shadow_agent.paged_bind_config($1,$2,$3) v',[run,lease,cfg]),true);
  assert.equal((await q('select count(*)::int n from shadow_agent.ranking_runs where run_id=$1',[run]))[0].n,1,'Every approved profile binds durable ranked execution');
  assert.deepEqual((await q('select config from shadow_agent.run_config where run_id=$1',[run]))[0].config,cfg);
  if(approved.model==='nvidia/nemotron-3.5-super-vl')for(const version of ['2026-11-17.1','2026-11-17.3']){const historical=randomUUID();await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)',[historical,newPagedShadowRun({runId:historical,scanStartedAt:new Date().toISOString()})]);const token=await value('select shadow_agent.claim($1,120) v',[historical]);assert.equal(await value('select shadow_agent.paged_bind_config($1,$2,$3) v',[historical,token,{...cfg,requestProfile:requestProfileForModel(approved.model,version)}]),true,'Historical billed NVIDIA profile remains explicitly bindable');}
 }
 assert.equal((await q('select count(*)::int n from shadow_agent.budgets'))[0].n,0);assert.equal((await q('select enabled from shadow_agent.producer_settings'))[0].enabled,false);
 console.log('PASS: JS/SQL approved registry parity, unchanged GPT-oss default, exact NVIDIA keyed profiles/provider/reasoning/caps and zero budget/activation changes');
}finally{await db.close();}
