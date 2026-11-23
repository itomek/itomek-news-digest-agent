// Real disposable SQL, one fabricated model call per invocation; no sender.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {sendPrepared,reconcile} from '../supabase/functions/_shared/sender.mjs';
import {newPagedShadowRun,runPagedShadowInvocation} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(),model='openai/gpt-oss-120b',account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const cfg={enabled:true,model,allowedModels:[model],maxOutputTokens:8192,maxCostCredits:.076596,apiKey:'fixture',timeoutMs:1000};
const key=n=>n.toString(16).padStart(64,'0');
const q=async(s,a=[])=>(await db.query(s,a)).rows;
const load=async f=>db.exec(await fs.readFile(new URL(f,import.meta.url),'utf8'));
const make=(n,title,url='https://example.com/'+n)=>({id:key(n),sourceUrl:url,sourceType:'rss',sourceCreatedAt:new Date().toISOString(),discoveryText:title});
async function seed(...stories){
 const runId=randomUUID(),stamp=new Date().toISOString();
 await q('select public.warpcore_ingest($1)',[stories.map(c=>({uri:'fixture:'+c.id,story_key:c.id,source_type:'rss',source_id:'official',actor:'official',text:c.discoveryText,source_created_at:c.sourceCreatedAt,source_url:c.sourceUrl,source_links:[c.sourceUrl]}))]);
 await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)',[runId,newPagedShadowRun({runId,scanStartedAt:stamp})]);
 return runId;
}
const read=async()=>q('select story_key,state,record_payload,approved_at,record_key,content_hash from public.warpcore_publications order by story_key');
async function review(stories,{changeHistory,skip=[],enabled=true}={}){
 const runId=await seed(...stories);let requests=0,historyHash;
 const invoke=()=>runPagedShadowInvocation({runId,config:cfg,fetchPage:async({cursor})=>cursor?[]:stories,query:(sql,args)=>db.query(sql.replace(/shadow_agent\.(paged_link_[a-z]+)/,'public.warpcore_shadow_$1'),args).catch(error=>{console.error(sql,error.message);throw error;}),fetcher:async(_url,{body})=>{
  requests++;
  const {priorCoverage,candidates}=JSON.parse(JSON.parse(body).messages[1].content);
  if(enabled){assert.ok(Array.isArray(priorCoverage.entries));historyHash=priorCoverage.snapshotHash;}
  else assert.equal(priorCoverage,undefined);
  await changeHistory?.();
  return Response.json({id:'fixture-generation-'+runId,model,provider:'Cerebras',usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4,cost:.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:Object.fromEntries(candidates.map(c=>[c.id,{rating:skip.includes(c.id)?'skip':'verify_i2_r2',reason:'Synthetic relevance decision'}]))})}}]});
 }},{pageSteps:2,reviewBatchSize:16,releaseLeaseOnSuccess:true,sourceLinkSelection:enabled});
 await invoke();const result=await invoke();
 assert.equal(result.state.reviewedCount,stories.length);assert.equal(requests,1);
 return {runId,historyHash};
}
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112201145_warpcore_hourly_batch_budget.sql','20261113011427_warpcore_native_reposts.sql'])await load('../supabase/migrations/'+f);
 for(const f of ['shared-admission','shadow-state','shadow-paged','shadow-audit','shadow-ranking','agent-verification','shadow-release'])await load('../supabase/functions/news-agent/sql/'+f+'.sql');
 await db.exec(`create table public.warpcore_source_roster(source_key text primary key,config_hash text not null);
 create table public.warpcore_source_sync(source_key text primary key,config_hash text not null);
 insert into public.warpcore_source_roster values('rss:official',repeat('b',64));
 insert into public.warpcore_source_sync values('rss:official',repeat('b',64));
 insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,5);`);
 await load('../supabase/migrations/20261123172000_warpcore_one_pass_headlines.sql');
 const first=make(1,'新 Release from the publisher\nThis description must not appear.'),unwanted=make(2,'Unrelated copy');
 const {runId,historyHash}=await review([first,unwanted],{skip:[unwanted.id]});
 const [post]=await read();assert.equal(post.story_key,first.id);assert.equal(post.state,'prepared');assert.ok(post.approved_at);
 assert.equal(post.record_payload.text,'Headline: 新 Release from the publisher\n\n'+first.sourceUrl);
 assert.equal(post.record_payload.facets[0].features[0].uri,first.sourceUrl);
 assert.equal((await read()).length,1);
 assert.deepEqual(await q('select history_hash,current_at_commit from shadow_agent.source_link_reviews where run_id=$1',[runId]),[{history_hash:historyHash,current_at_commit:true}]);
 assert.equal((await q('select count(*)::int as n from agent_verification.receipts'))[0].n,0);
 assert.equal((await q('select count(*)::int as n from public.warpcore_curator_inbox'))[0].n,0);
 // A different story key and changed heading do not bypass exact URL dedup.
 await review([make(3,'A differently worded story',first.sourceUrl)]);assert.equal((await read()).length,1);
 // Change actual published history between HTTP and commit; old judgment may not enqueue.
 const stale=await review([make(4,'Another distinct development')],{changeHistory:()=>q("update public.warpcore_candidates set text='New past context' where story_key=$1",[first.id])});
 assert.equal((await q('select current_at_commit from shadow_agent.source_link_reviews where run_id=$1',[stale.runId]))[0].current_at_commit,false);assert.equal((await read()).length,1);
 await review([make(5,'A legacy decision')],{enabled:false});assert.equal((await read()).length,1);
 assert.equal((await q('select count(*)::int n from public.warpcore_publications where account_did=$1',[account]))[0].n,1);
 const job={accountDid:account,storyKey:post.story_key,record:post.record_payload,recordKey:post.record_key,contentHash:post.content_hash};
 const args=[account,job.storyKey,job.contentHash,job.record],uri='at://'+account+'/app.bsky.feed.post/'+job.recordKey;
 const sq=async(name,extra=[])=>(await q('select public.warpcore_'+name+'('+[...args,...extra].map((_,i)=>'$'+(i+1)).join(',')+') as value',[...args,...extra]))[0].value;
 const adapter={
  claim:async()=>{const rows=await q('select * from public.warpcore_claim_publication($1,$2,$3,$4)',args);return rows.length?job:null;},
  uncertain:()=>sq('mark_uncertain'),checked:()=>sq('mark_checked'),manualReview:()=>sq('mark_manual_review'),published:(_job,url)=>sq('mark_published',[url])
 };
 let remoteRecord,writes=0;
 const remote={put:async(_did,_tid,record)=>{writes++;remoteRecord=record;throw Error('Synthetic lost response after write');},get:async()=>({uri,record:remoteRecord})};
 const policy={enabled:true,accountDid:account};
 assert.equal((await sendPrepared(job,adapter,remote,policy)).state,'uncertain');
 assert.equal((await sendPrepared(job,adapter,remote,policy)).state,'not_claimed');
 assert.equal((await reconcile(job,adapter,remote)).state,'published');
 assert.equal((await read())[0].state,'published');assert.equal(writes,1,'Uncertain write never sends a second time');
 const nextA=make(6,'Independent release A'),nextB=make(7,'Independent release B'),duplicate=make(8,'A rewrite of release A',nextA.sourceUrl);
 await review([nextA,nextB,duplicate]);
 const queued=(await read()).filter(row=>row.state==='prepared');
 assert.deepEqual(queued.map(row=>row.story_key),[nextA.id,nextB.id]);
 assert.equal(new Set(queued.map(row=>row.record_key)).size,2,'Same hash prefix and batch cannot collide');

 await db.exec('set role anon');await assert.rejects(()=>q('select public.warpcore_shadow_paged_link_history($1,null,0)',[runId]),/permission/);
 console.log('PASS one-pass selection to existing prepared queue, exact headline and link, skip/duplicate/stale/legacy/roles, no verify receipt or send');
}finally{await db.close();}
