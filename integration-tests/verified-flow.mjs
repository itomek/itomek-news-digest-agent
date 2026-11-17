// Full real-contract composition. Fabricated source/model only, never a sender.
// Optional independent PostgreSQL backend must be exclusively disposable loopback.
import {PGlite} from '@electric-sql/pglite';import {Client} from 'pg';
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {randomUUID,createHash,webcrypto} from 'node:crypto';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';
globalThis.crypto??=webcrypto;
let db;const connection=process.env.WARPCORE_TEST_DATABASE_URL;
if(connection){const u=new URL(connection);if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!='/warpcore_test'||u.search||u.hash)throw Error('Disposable loopback warpcore_test required');const client=new Client({connectionString:u.href});await client.connect();db={query:(s,args=[])=>client.query(s,args.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v)),exec:s=>client.query(s),close:()=>client.end()};}else db=new PGlite();
const q=async(s,a=[])=>(await db.query(s,a)).rows,scalar=async(s,a=[])=>(await q(s,a))[0].value;
const load=async f=>db.exec(await fs.readFile(new URL(f,import.meta.url),'utf8'));
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const hash=s=>createHash('sha256').update(s).digest('hex'),key=n=>n.toString(16).padStart(64,'0');
const account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',model='openai/gpt-oss-120b',run=randomUUID();
const snapshot=s=>scalar('select public.warpcore_curator_snapshot($1) value',[s]);
const history=()=>scalar('select public.warpcore_agent_history() value');
const queueCount=()=>scalar("select count(*)::int value from (select story_key from public.warpcore_curator_inbox where state in ('pending','leased') union select story_key from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review'))x");
const attest={factsVerified:true,meaningfulChange:true,scopeApproved:true};
const editorial=s=>({summary:'A new verified capability is available.',whyItMatters:'The release improves practical access.',change:'New capability in the official release.',political:false,evidenceIds:[s.evidence[0].id],verification:{checkedAt:new Date().toISOString(),sourceUrls:[s.evidence[0].url],reason:'Fabricated acceptance evidence with exact quote binding.'}});
try{
 assert.equal(await scalar("select to_regclass('public.warpcore_stories') is null and to_regnamespace('shadow_agent') is null value"),true,'Refuse existing fixture');
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112201145_warpcore_hourly_batch_budget.sql','20261113011427_warpcore_native_reposts.sql'])await load('../supabase/migrations/'+f);
 for(const f of ['shared-admission.sql','shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql','agent-verification.sql','verification-jobs.sql','runtime-bootstrap.sql'])await load('../supabase/functions/news-agent/sql/'+f);
 await db.exec('create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);');
 await db.exec('set role service_role');
 assert.deepEqual(await scalar('select public.warpcore_agent_authorization() value'),{enabled:false});assert.equal(await scalar('select public.warpcore_verification_claim() value'),null);
 await admin(async()=>{
  await q('select public.warpcore_ingest($1)',[Array.from({length:11},(_,i)=>({uri:'fixture:'+i,story_key:key(i+1),source_type:'rss',source_id:'official',actor:'official',text:'Synthetic public release '+i,source_created_at:new Date().toISOString(),source_url:'https://example.com/'+(i+1),source_links:['https://example.com/'+(i+1)]}))]);
  await q("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
  await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,.3)',[run,newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()})]);
  await db.exec("update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=.2;update shadow_agent.producer_settings set enabled=true,run_limit_credits=.3,policy_version='2026-11-14.1';update shadow_agent.runtime_settings set allowed_source_hosts=array['example.com']");
  await q('insert into vault.decrypted_secrets values($1,$2),($3,$4)',['warpcore_agent_cron_token','synthetic-token-'.repeat(3),'warpcore_agent_openrouter_key','synthetic-key-'.repeat(3)]);
  // Existing Dot writer contributes four slots before model history capture.
  for(let n=2;n<=5;n++){const s=await snapshot(key(n));await scalar('select public.warpcore_curator_submit($1,$2,$3,$4,$5,$6) value',[key(n),s.evidence_hash,editorial(s),attest,'real-dot',randomUUID()]);}
 });
 assert.equal(await queueCount(),4);
 const runtimeConfig=await scalar('select public.warpcore_agent_runtime_config() value');assert.equal(runtimeConfig.model,model);assert.equal(runtimeConfig.maxCostCredits,.076596);
 const lease=await scalar('select shadow_agent.claim($1,120) value',[run]);let state=await scalar('select shadow_agent.load($1) value',[run]);
 const cfg={model,requestProfile:requestProfileForModel(model,'2026-11-16.4'),expectedProvider:'Groq',maxOutputTokens:100,maxCostCredits:.1,timeoutMs:1000,maxResponseBytes:20000,policyVersion:state.policyVersion,routing:'openrouter-no-fallback'};
 await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[run,lease,cfg]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[1,7,8,9,10,11].map(n=>({id:key(n),sourceUrl:'https://example.com/'+n,discoveryText:'Synthetic candidate needing complete verification.'}))]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[]]);
 state=(await scalar('select shadow_agent.paged_begin($1,$2,$3,6) value',[run,lease,state.revision])).state;
 const discovery=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,.1) value',[run,lease,state.revision,hash('fabricated discovery request')]);
 await scalar('select shadow_agent.dispatch($1,$2) value',[discovery.attemptId,lease]);
 const audit=cost=>({model,provider:'Groq',generationId:'synthetic-'+randomUUID(),usage:{promptTokens:10,completionTokens:5,totalTokens:15,costCredits:cost}});
 await scalar("select shadow_agent.paged_settle($1,$2,'settled',.01,$3) value",[discovery.attemptId,lease,audit(.01)]);
 state=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) value',[run,lease,state.revision,[1,7,8,9,10,11].map(n=>({id:key(n),action:'verify',reason:'Synthetic meaningful release.',importance:n===1?3:4,relevance:4}))]);
 state=(await scalar('select shadow_agent.paged_begin($1,$2,$3,6) value',[run,lease,state.revision])).state;assert.equal(state.phase,'complete');
 const selection=await scalar('select public.warpcore_shadow_selection($1) value',[run]);assert.equal(selection.items.length,5);assert.equal(selection.items[0].factsVerified,false);
 const originalSelection=JSON.stringify(selection);
 for(let n=7;n<=11;n++){
  const deferred=await scalar('select public.warpcore_verification_claim() value');assert.equal(deferred.storyKey,key(n));
  assert.equal(await scalar("select public.warpcore_verification_finish($1,$2,'deferred',null) value",[deferred.jobId,deferred.lease]),true,'Initial candidate can defer without paid attempt after inaccessible-source fixture');
 }
 assert.equal(await scalar('select public.warpcore_verification_claim() value'),null,'Default disabled backfill stops after original five');
 await admin(()=>db.exec('update shadow_agent.verification_settings set backfill_enabled=true'));
 const job=await scalar('select public.warpcore_verification_claim() value');assert.equal(job.storyKey,key(1));assert.equal(job.rankingRunId,run);
 const s=await snapshot(key(1)),h=await history(),date=new Date().toISOString().slice(0,10),body=`🦀 Official release ${date}: a useful new capability is available.`,quote=body.slice(3);
 const requestBody=JSON.stringify({model,messages:[{role:'user',content:body}],response_format:'fabricated verification schema'}),requestHash=hash(requestBody),meta={model,profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'};
 assert.equal(requestBody.includes(runtimeConfig.apiKey),false,'Model prompt never receives API key');
 await scalar('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) value',[job.jobId,job.lease,requestHash,.058983,meta]);await scalar('select public.warpcore_verification_dispatch($1,$2) value',[job.jobId,job.lease]);
 await scalar("select public.warpcore_verification_settle($1,$2,'settled',.02,$3) value",[job.jobId,job.lease,audit(.02)]);
 const material={version:'agent-verification-v1',agentId:'warpcore-news-agent-v1',runId:run,storyKey:key(1),evidenceHash:s.evidence_hash,editorial:editorial(s),model,policyVersion:state.policyVersion,requestProfileVersion:meta.profileVersion,requestSha256:requestHash,judgment:{method:'model-supported-primary-evidence',factsSupported:true,scopeApproved:true,meaningfulChange:true,dedupClear:true,checkedAt:new Date().toISOString(),claims:[{claim:'The official release adds a useful capability.',evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),quote,quoteStart:2,quoteEnd:Array.from(body).length}],publicationDate:date,scopeReason:'Direct engineering relevance.',changeReason:'New release capability.',dedupReason:'Fabricated model found no duplicate in complete captured history.',historyHash:h.snapshotHash},sources:[{evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),fetchedAt:new Date().toISOString(),body}]};
 for(const mutate of [m=>m.judgment.claims[0].quoteStart=3,m=>m.judgment.historyHash='0'.repeat(64)]){const bad=structuredClone(material);bad.requestSha256=hash(randomUUID());mutate(bad);await assert.rejects(()=>scalar('select public.warpcore_agent_issue_receipt($1) value',[bad]),/quote|judgment/i);}
 assert.equal(JSON.stringify(await scalar('select public.warpcore_shadow_selection($1) value',[run])),originalSelection,'Rank-six verification never rewrites frozen original top five');
 const receipt=await scalar('select public.warpcore_agent_issue_receipt($1) value',[material]);
 assert.equal(await scalar("select public.warpcore_verification_finish($1,$2,'verified',$3) value",[job.jobId,job.lease,receipt]),true);
 // Lose the finish response before submission; next invocation recovers only handoff.
 await admin(()=>q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[job.jobId]));
 const recovered=await scalar('select public.warpcore_verification_claim() value');assert.equal(recovered.jobId,job.jobId);assert.equal(recovered.handoffReceiptId,receipt);
 const inbox=await scalar('select public.warpcore_verification_handoff($1,$2) value',[job.jobId,recovered.lease]);assert.equal(await scalar('select public.warpcore_verification_handoff($1,$2) value',[job.jobId,recovered.lease]),inbox);assert.equal(await queueCount(),5);assert.equal(await scalar('select public.warpcore_agent_submit($1) value',[receipt]),inbox);
 const rows=await q('select * from public.warpcore_curator_claim(5)'),agent=rows.find(r=>r.id===inbox),dot=rows.find(r=>r.actor_kind==='dot');assert.equal(agent.agent_id,material.agentId);assert.equal(agent.dot_id,null);assert.equal(dot.dot_id,'real-dot');
 const finalize=async row=>{const packet=await createReviewPacket({storyKey:row.story_key,evidence:row.evidence,editorial:row.editorial});const transport={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(row.created_at).toISOString()),storyKey:row.story_key};assert.ok([...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(transport.record.text)].length<=300);assert.ok(new TextEncoder().encode(transport.record.text).length<=3000);assert.equal(await scalar('select public.warpcore_curator_finalize($1,$2,$3,$4) value',[row.id,row.lease_token,packet,transport]),true);return transport;};
 const approved=await finalize(agent);assert.equal(await queueCount(),5,'Transfer does not double count at capacity');
 const publication=(await q('select * from public.warpcore_publications where story_key=$1',[key(1)]))[0];assert.equal(publication.state,'prepared');assert.deepEqual(publication.record_payload,approved.record);assert.equal(publication.record_key,approved.recordKey);assert.equal(publication.content_hash,approved.contentHash);assert.ok(publication.approved_at);assert.equal(publication.remote_uri,null);
 await finalize(dot);assert.equal(await queueCount(),5,'Old Dot path preserves global cap');
 await assert.rejects(()=>scalar('select public.warpcore_prepare_publication($1,$2,$3,$4,$5) value',[account,key(6),hash('sixth'),{$type:'app.bsky.feed.post',text:'No admission'},'3m3e4a2b22222']),/Combined pending limit/);
 await admin(async()=>{const budget=(await q('select * from shadow_agent.budgets'))[0];assert.equal(Number(budget.spent_credits),.03);assert.equal(Number(budget.held_credits),0);const ledger=(await q('select j.*,a.request_hash,a.status attempt_status from shadow_agent.verification_jobs j join shadow_agent.attempts a on a.run_id=j.child_run_id'))[0];assert.equal(ledger.status,'verified');assert.equal(ledger.request_hash,material.requestSha256);assert.equal(ledger.receipt_id,receipt);assert.equal(ledger.attempt_status,'settled');assert.equal((await q('select count(*)::int n from public.warpcore_publication_slots'))[0].n,0,'No sending attempt');});
 for(const table of ['runtime_settings','verification_settings','verification_jobs','verification_audit','budgets'])await assert.rejects(()=>q('select * from shadow_agent.'+table),/permission/);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);for(const expression of ['warpcore_verification_claim()','warpcore_agent_authorization()','warpcore_agent_runtime_config()'])await assert.rejects(()=>scalar('select public.'+expression+' value'),/permission/);await db.exec('reset role');}
 console.log('PASS: rank-six backfill after five deferred frozen proposals → real ranked SQL → paid verifier ledger → Unicode/history-bound receipt → truthful agent inbox → exact curator finalization; global five with Dot coexistence, zero send attempts');
}finally{await db.close();}
