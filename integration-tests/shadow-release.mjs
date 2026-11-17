// Disposable SQL only: no model, hosted service or publication calls.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(),q=(sql,args=[])=>db.query(sql,args),value=async(sql,args=[])=>(await q(sql,args)).rows[0].value;
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-release.sql'])await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+file,import.meta.url),'utf8'));
 const run=randomUUID(),state=newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()});await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)',[run,state]);
 await db.exec('set role service_role');const claim=()=>value('select shadow_agent.claim($1,60) as value',[run]);const release=token=>value('select public.warpcore_shadow_release($1,$2) as value',[run,token]);
 const first=await claim();assert.equal(await release(first),true);const second=await claim();assert.ok(second&&second!==first);assert.equal(await release(first),false);assert.equal(await claim(),null);
 await db.exec('reset role');await q("update shadow_agent.runs set state=state||'{\"phase\":\"reviewing\"}'::jsonb where id=$1",[run]);await db.exec('set role service_role');assert.equal(await release(second),false);
 await db.exec('reset role');await q("update shadow_agent.runs set state=state||'{\"phase\":\"uncertain\"}'::jsonb where id=$1",[run]);await db.exec('set role service_role');assert.equal(await release(second),false);
 await db.exec('reset role');await q("update shadow_agent.runs set state=state||'{\"phase\":\"review\"}'::jsonb,revision=7 where id=$1",[run]);await db.exec('set role service_role');assert.equal(await release(second),true);
 assert.equal(await value('select (shadow_agent.load($1)->>\'revision\')::int as value',[run]),0,'Release does not modify checkpoint JSON');
 await db.exec('reset role');assert.equal((await q('select revision from shadow_agent.runs where id=$1',[run])).rows[0].revision,7,'Release does not overwrite checkpoint revision');await db.exec('set role service_role');
 const third=await claim();assert.equal(await release(second),false);assert.equal(await claim(),null);assert.equal(await release(third),true);
 const fourth=await claim();
 await db.exec('reset role');await q("update shadow_agent.runs set state=state-'phase' where id=$1",[run]);await db.exec('set role service_role');assert.equal(await release(fourth),false,'Missing phase must fail closed');
 await db.exec('reset role');await q("update shadow_agent.runs set state=state||'{\"phase\":\"review\"}'::jsonb where id=$1",[run]);
 await q("insert into shadow_agent.budgets(day,limit_credits) values(current_date,1)");
 await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,checkpoint_revision) values($1,current_date,$2,$3,.1,7)",[run,fourth,'a'.repeat(64)]);await db.exec('set role service_role');
 assert.equal(await release(fourth),false,'Reserved paid attempt cannot release even with a nominally safe phase');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(release(third),/permission denied/);}
 console.log('PASS: fenced safe lease release, stale-worker refusal, reviewing/uncertain refusal, immutable checkpoint and private grants');
}finally{await db.close();}
