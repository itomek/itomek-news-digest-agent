// Current V5 runtime acceptance; historical V1/V2 archive compatibility is tested separately.
// Full real-contract composition. Fabricated source/model only, never a sender.
// Optional independent PostgreSQL backend must be exclusively disposable loopback.
import {PGlite} from '@electric-sql/pglite';import {Client} from 'pg';
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {randomUUID,createHash,webcrypto} from 'node:crypto';
import {runVerificationInvocation} from '../supabase/functions/news-agent/verification-runtime.mjs';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
import {requestProfileForModel} from '../supabase/functions/news-agent/model-profiles.mjs';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
import {primarySourceAttributionLabel} from '../supabase/functions/news-agent/primary-source-policy.mjs';
import {preview} from '../supabase/functions/_shared/publishing.mjs';
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
const sourceUrl='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1';
const attest={factsVerified:true,meaningfulChange:true,scopeApproved:true};
const editorial=s=>({summary:'A new verified capability is available.',whyItMatters:'The release improves practical access.',change:'New capability in the official release.',political:false,evidenceIds:[s.evidence[0].id],verification:{checkedAt:new Date().toISOString(),sourceUrls:[s.evidence[0].url],reason:'Fabricated acceptance evidence with exact quote binding.'}});
try{
 assert.equal(await scalar("select to_regclass('public.warpcore_stories') is null and to_regnamespace('shadow_agent') is null value"),true,'Refuse existing fixture');
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112201145_warpcore_hourly_batch_budget.sql','20261113011427_warpcore_native_reposts.sql'])await load('../supabase/migrations/'+f);
 for(const f of ['shared-admission.sql','shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql','agent-verification.sql','verification-jobs.sql'])await load('../supabase/functions/news-agent/sql/'+f);
 await db.exec('set role service_role');
assert.equal(await scalar('select public.warpcore_verification_claim() value'),null);
 await admin(async()=>{
  await q('select public.warpcore_ingest($1)',[Array.from({length:6},(_,i)=>({uri:'fixture:'+i,story_key:key(i+1),source_type:'rss',source_id:'official',actor:'official',text:'Synthetic public release '+i,source_created_at:new Date().toISOString(),source_url:i===0?sourceUrl:'https://example.com/'+(i+1),source_links:[i===0?sourceUrl:'https://example.com/'+(i+1)]}))]);
  await q("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
  await q('insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,.3)',[run,newPagedShadowRun({runId:run,scanStartedAt:new Date().toISOString()})]);
  await db.exec("update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=.2;update shadow_agent.producer_settings set enabled=true,run_limit_credits=.3,policy_version='2026-11-14.1'");


  // Existing Dot writer contributes four slots before model history capture.
  for(let n=2;n<=5;n++){const s=await snapshot(key(n));await scalar('select public.warpcore_curator_submit($1,$2,$3,$4,$5,$6) value',[key(n),s.evidence_hash,editorial(s),attest,'real-dot',randomUUID()]);}
 });
 assert.equal(await queueCount(),4);
 const runtimeConfig={enabled:true,model,maxCostCredits:.076596,maxOutputTokens:8192,apiKey:'synthetic-not-a-credential',allowedModels:[model],expectedProvider:'Cerebras',allowedSourceHosts:['github.com']};
 const lease=await scalar('select shadow_agent.claim($1,120) value',[run]);let state=await scalar('select shadow_agent.load($1) value',[run]);
 const cfg={model,requestProfile:requestProfileForModel(model,'2026-11-16.4'),expectedProvider:'Groq',maxOutputTokens:100,maxCostCredits:.1,timeoutMs:1000,maxResponseBytes:20000,policyVersion:state.policyVersion,routing:'openrouter-no-fallback'};
 await scalar('select shadow_agent.paged_bind_config($1,$2,$3) value',[run,lease,cfg]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[{id:key(1),sourceUrl,discoveryText:'Synthetic candidate needing complete verification.'}]]);
 state=await scalar('select shadow_agent.paged_append($1,$2,$3,$4) value',[run,lease,state.revision,[]]);
 state=(await scalar('select shadow_agent.paged_begin($1,$2,$3,1) value',[run,lease,state.revision])).state;
 const discovery=await scalar('select shadow_agent.paged_reserve($1,$2,$3,$4,.1) value',[run,lease,state.revision,hash('fabricated discovery request')]);
 await scalar('select shadow_agent.dispatch($1,$2) value',[discovery.attemptId,lease]);
 const audit=cost=>({model,provider:'Groq',generationId:'synthetic-'+randomUUID(),usage:{promptTokens:10,completionTokens:5,totalTokens:15,costCredits:cost}});
 await scalar("select shadow_agent.paged_settle($1,$2,'settled',.01,$3) value",[discovery.attemptId,lease,audit(.01)]);
 state=await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) value',[run,lease,state.revision,[{id:key(1),action:'verify',reason:'Synthetic meaningful release.',importance:3,relevance:4}]]);
 state=(await scalar('select shadow_agent.paged_begin($1,$2,$3,1) value',[run,lease,state.revision])).state;assert.equal(state.phase,'complete');
 const selection=await scalar('select public.warpcore_shadow_selection($1) value',[run]);assert.equal(selection.items.length,1);assert.equal(selection.items[0].factsVerified,false);
 const methods={warpcore_verification_claim:[],warpcore_curator_snapshot:['p_story'],warpcore_agent_history:['p_cursor'],warpcore_verification_reserve:['p_job','p_lease','p_hash','p_max','p_metadata'],warpcore_verification_dispatch:['p_job','p_lease'],warpcore_verification_settle:['p_job','p_lease','p_status','p_cost','p_audit'],warpcore_agent_issue_receipt:['p_material'],warpcore_verification_finish:['p_job','p_lease','p_status','p_receipt'],warpcore_verification_handoff:['p_job','p_lease']};
 let modelCalls=0,sourceCalls=0,material,jobId,invalidDate=false;
 const rpc=async(name,args)=>{const names=methods[name];assert.ok(names);if(name==='warpcore_agent_issue_receipt')material=args.p_material;const result=await scalar('select public.'+name+'('+names.map((_,i)=>'$'+(i+1)).join(',')+') value',names.map(k=>args[k]));if(name==='warpcore_verification_claim'&&result)jobId=result.jobId;return result;};
 const date=new Date().toISOString().slice(0,10),change='A new optimized runtime backend is available.';
 const attributionPrefix=primarySourceAttributionLabel(sourceUrl)+' reports: ';
 const skeleton={storyKey:key(1),verified:true,approved:true,summary:attributionPrefix+'S',whyItMatters:'W',links:[sourceUrl]};
 const remaining=300-preview(skeleton).graphemes,summary='S'+'s'.repeat(Math.floor(remaining*.75)),why='W'+'w'.repeat(remaining-Math.floor(remaining*.75));

 assert.ok(summary.length>why.length*2,'V5 permits asymmetric prose allocation within the same complete 300-grapheme post');
 const releaseData={html_url:sourceUrl,tag_name:'v2026.47.1',draft:false,prerelease:false,published_at:new Date().toISOString(),body:`Official release ${date}. ${summary} ${why} ${change} `+'Public technical context. '.repeat(200)},sourceBody=JSON.stringify(releaseData);

 const invoke=()=>runVerificationInvocation({config:runtimeConfig,rpc,evidenceFetcher:async(target,options)=>{sourceCalls++;assert.equal(target,'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1');assert.equal(options.headers.Authorization,undefined);return new Response(sourceBody,{headers:{'content-type':'application/json'}});},modelFetcher:async(target,options)=>{
  modelCalls++;assert.equal(target,'https://openrouter.ai/api/v1/chat/completions');const requestHash=hash(options.body);
  const attempt=await admin(()=>q('select a.status,a.request_hash from shadow_agent.attempts a join shadow_agent.verification_jobs j on j.child_run_id=a.run_id where j.id=$1',[jobId]));assert.equal(attempt[0].status,'dispatched');assert.equal(attempt[0].request_hash,requestHash);
  const input=JSON.parse(JSON.parse(options.body).messages[1].content),source=input.sources[0];assert.equal(source.url,sourceUrl);assert.equal(source.captureKind,'github-release-v1');assert.equal(source.fetchedUrl,'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1');assert.equal(Object.hasOwn(source,'body'),false);assert.equal(source.bodyChunks.map(c=>c.text).join(''),sourceBody);assert.ok(source.bodyChunks.length>1);assert.ok(source.bodyChunks.every(c=>c.text.length<=2500));assert.equal(source.attributionPrefix,attributionPrefix);assert.equal(input.history.items.length,4);assert.equal(options.body.includes(runtimeConfig.apiKey),false);
  const result={action:'approve',editorial:{political:false,summary,whyItMatters:why,change,evidenceIds:[source.evidenceId]},publicationDate:invalidDate?date+'T12:00:00Z':date,scopeReason:'Direct engineering relevance.',changeReason:'Official new backend.',dedupReason:'Distinct from all four pending events.',supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,source.bodyChunks[0].id]))};

  return Response.json({id:'synthetic-native-verification',model,provider:'Cerebras',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:.02},choices:[{finish_reason:'stop',message:{content:JSON.stringify({result})}}]});
 }});
 await db.exec('begin');invalidDate=true;
 const badDate=await invoke();assert.equal(badDate.status,'deferred');assert.equal(badDate.reason,'billed_invalid_completion');
 await admin(async()=>{assert.equal((await q('select count(*)::int n from agent_verification.receipts'))[0].n,0);const a=(await q("select audit from shadow_agent.verification_audit where status='settled'"))[0].audit;assert.equal(a.validationError,'invalid_verification_schema');assert.equal(Number(a.usage.costCredits),.02);assert.equal(Number((await q('select held_credits from shadow_agent.budgets'))[0].held_credits),0);});
 await db.exec('rollback');invalidDate=false;modelCalls=0;sourceCalls=0;
 const outcome=await invoke();
 assert.equal(outcome.status,'submitted',JSON.stringify(outcome));assert.equal(modelCalls,1);assert.equal(sourceCalls,1);const inbox=outcome.inboxId,receipt=outcome.receiptId;
 assert.equal(await queueCount(),5);assert.equal(material.requestProfileVersion,'2026-11-17.verify.5');assert.equal(material.sources[0].url,sourceUrl);assert.equal(material.sources[0].captureKind,'github-release-v1');assert.equal(material.sources[0].body,sourceBody);assert.equal(material.editorial.summary,attributionPrefix+summary);assert.equal(material.judgment.claims.length,4);assert.ok(material.judgment.claims.every(c=>c.quote.length<=2500&&sourceBody.includes(c.quote)));assert.ok(material.judgment.claims.every(c=>c.url===sourceUrl&&c.contentSha256===hash(sourceBody)));
 const rows=await q('select * from public.warpcore_curator_claim(5)'),agent=rows.find(r=>r.id===inbox),dot=rows.find(r=>r.actor_kind==='dot');assert.equal(agent.agent_id,material.agentId);assert.equal(agent.dot_id,null);assert.equal(dot.dot_id,'real-dot');
 const finalize=async row=>{const packet=await createReviewPacket({storyKey:row.story_key,evidence:row.evidence,editorial:row.editorial});const transport={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(row.created_at).toISOString()),storyKey:row.story_key};assert.equal(await scalar('select public.warpcore_curator_finalize($1,$2,$3,$4) value',[row.id,row.lease_token,packet,transport]),true);return transport;};
 const approved=await finalize(agent);assert.equal(await queueCount(),5,'Transfer does not double count at capacity');
 const publication=(await q('select * from public.warpcore_publications where story_key=$1',[key(1)]))[0];assert.equal(publication.state,'prepared');assert.deepEqual(publication.record_payload,approved.record);assert.equal(publication.record_key,approved.recordKey);assert.equal(publication.content_hash,approved.contentHash);assert.ok(publication.approved_at);assert.equal(publication.remote_uri,null);assert.equal(publication.record_payload.$type,'app.bsky.feed.post');assert.equal([...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(publication.record_payload.text)].length,300,'Exact 300-grapheme post survives real curator finalization');
 await finalize(dot);assert.equal(await queueCount(),5,'Old Dot path preserves global cap');
 await assert.rejects(()=>scalar('select public.warpcore_prepare_publication($1,$2,$3,$4,$5) value',[account,key(6),hash('sixth'),{$type:'app.bsky.feed.post',text:'No admission'},'3m3e4a2b22222']),/Combined pending limit/);
 await admin(async()=>{const budget=(await q('select * from shadow_agent.budgets'))[0];assert.equal(Number(budget.spent_credits),.03);assert.equal(Number(budget.held_credits),0);const ledger=(await q('select j.*,a.request_hash,a.status attempt_status from shadow_agent.verification_jobs j join shadow_agent.attempts a on a.run_id=j.child_run_id'))[0];assert.equal(ledger.status,'verified');assert.equal(ledger.request_hash,material.requestSha256);assert.equal(ledger.receipt_id,receipt);assert.equal(ledger.attempt_status,'settled');const retained=(await q("select audit from shadow_agent.verification_audit where status='settled'"))[0].audit.result;assert.ok(Object.values(retained.supports).every(id=>/^source-1-chunk-[0-9]{4}$/.test(id)));assert.equal(retained.claims,undefined);assert.equal((await q('select count(*)::int n from public.warpcore_publication_slots'))[0].n,0,'No sending attempt');});
 for(const table of ['verification_settings','verification_jobs','verification_audit','budgets'])await assert.rejects(()=>q('select * from shadow_agent.'+table),/permission/);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);for(const expression of ['warpcore_verification_claim()'])await assert.rejects(()=>scalar('select public.'+expression+' value'),/permission/);await db.exec('reset role');}
 console.log('PASS: GitHub official release API → V5 raw JSON chunk-ID supports + actual runtime + ranked paid ledger + exact date/hash/quote receipt + curator 300-grapheme post; five global slots with Dot coexistence and zero sends');
}finally{await db.close();}
