// Real independent PostgreSQL sessions; fresh disposable loopback database only.
// Run with WARPCORE_TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/warpcore_test
import {Client} from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createVerificationService} from '../supabase/functions/news-agent/verification-services.mjs';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test'||url.search||url.hash)throw Error('Dedicated loopback warpcore_test database required');
const writer=new Client({connectionString:url.href}),reader=new Client({connectionString:url.href});
const q=async(sql,args=[])=>(await reader.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const hash=s=>createHash('sha256').update(s).digest('hex');
const key=n=>n.toString(16).padStart(64,'0'),date=new Date().toISOString().slice(0,10);
const snapshot=story=>scalar('select public.warpcore_curator_snapshot($1) value',[story]);
const history=()=>scalar('select public.warpcore_agent_history() value');
const issue=m=>scalar('select public.warpcore_agent_issue_receipt($1) value',[m]);
const submit=id=>scalar('select public.warpcore_agent_submit($1) value',[id]);
async function seed(n){await q('select public.warpcore_ingest($1)',[JSON.stringify([{uri:`fixture:${n}`,story_key:key(n),source_type:'rss',source_id:'official',actor:'official',text:'Public release',source_created_at:new Date().toISOString(),source_url:`https://example.com/${n}`,source_links:[`https://example.com/${n}`]}])]);return key(n);}
async function material(story){
 const s=await snapshot(story),h=await history();const body=`🦀 Official release ${date}: new capability is available.`;
 const quote=`Official release ${date}: new capability is available.`;
 return {version:'agent-verification-v1',agentId:'warpcore-news-agent-v1',runId:randomUUID(),storyKey:story,evidenceHash:s.evidence_hash,editorial:{summary:'A new capability is available.',whyItMatters:'The release expands practical access.',change:'New official release',political:false,evidenceIds:[s.evidence[0].id],verification:{checkedAt:new Date().toISOString(),sourceUrls:[s.evidence[0].url],reason:'Model-supported primary evidence with exact source quote.'}},model:'fixture/verification-model',policyVersion:'2026-11-14.1',requestProfileVersion:'fixture-v1',requestSha256:hash(randomUUID()),judgment:{method:'model-supported-primary-evidence',factsSupported:true,scopeApproved:true,meaningfulChange:true,dedupClear:true,checkedAt:new Date().toISOString(),claims:[{claim:`The release on ${date} adds a capability.`,evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),quote,quoteStart:2,quoteEnd:Array.from(body).length}],publicationDate:date,scopeReason:'Direct engineering relevance.',changeReason:'New release capability.',dedupReason:'No same event in complete history.',historyHash:h.snapshotHash},sources:[{evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),fetchedAt:new Date().toISOString(),body}]};
}
try{
 await Promise.all([writer.connect(),reader.connect()]);
 await Promise.all([writer.query("set statement_timeout='5s'"),reader.query("set statement_timeout='5s'")]);
 // The dedicated loopback database is disposable; earlier concurrency suites may leave fixtures.
 await q('drop schema if exists warpcore_admission cascade;drop schema if exists agent_verification cascade;drop schema if exists shadow_agent cascade;drop schema public cascade;create schema public');
 for(const role of ['anon','authenticated','service_role'])if(!(await q('select 1 from pg_roles where rolname=$1',[role])).length)await q('create role '+role+(role==='service_role'?' bypassrls':''));
 for(const p of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112192659_warpcore_tid_record_keys.sql','20261113011427_warpcore_native_reposts.sql'])await reader.query(await fs.readFile(new URL('../supabase/migrations/'+p,import.meta.url),'utf8'));
 for(const p of ['shared-admission.sql','agent-verification.sql'])await reader.query(await fs.readFile(new URL('../supabase/functions/news-agent/sql/'+p,import.meta.url),'utf8'));
 const historical=await seed(1),first=await issue(await material(historical)),inbox=await submit(first);
 const before=await history();
 await writer.query('begin');
 await writer.query("update public.warpcore_candidates set text='Changed historical context' where story_key=$1",[historical]);
 await assert.rejects(history,e=>e.code==='55P03','Actual candidate trigger lock conflicts with NOWAIT history');
 let historyCalls=0,sourceCalls=0,paidCalls=0;
 function service(release){
  return createVerificationService({projectUrl:'https://fixture.supabase.co',serviceKey:'synthetic',runtimeConfig:{enabled:true,apiKey:'synthetic',model:'openai/gpt-oss-120b',allowedModels:['openai/gpt-oss-120b'],expectedProvider:'Cerebras',maxOutputTokens:4096,maxCostCredits:.076596,allowedSourceHosts:['ir.amd.com']}},{
   rpcFetcher:async(target,options)=>{
    const name=target.pathname.split('/').at(-1),args=JSON.parse(options.body);
    if(name==='warpcore_verification_claim')return Response.json({jobId:randomUUID(),rankingRunId:randomUUID(),storyKey:key(2),lease:randomUUID()});
    if(name==='warpcore_curator_snapshot')return Response.json(await snapshot(key(2)));
    if(name==='warpcore_agent_history'){
     historyCalls++;
     try{return Response.json(await scalar('select public.warpcore_agent_history($1) value',[args.p_cursor]));}
     catch(error){assert.equal(error.code,'55P03');if(release)await writer.query('commit');return Response.json({code:error.code,message:error.message,details:error.detail??null,hint:null},{status:500});}
    }
    if(name==='warpcore_verification_finish'){assert.equal(args.p_status,'deferred');return Response.json(true);}
    paidCalls++;throw Error('Must not reserve or dispatch');
   },evidenceFetcher:async()=>{sourceCalls++;throw Error('Stop after verified history read');},modelFetcher:async()=>{paidCalls++;throw Error('Must not infer');},
  });
 }
 await seed(2);await q("update public.warpcore_candidates set source_url='https://ir.amd.com/fixture-release',source_links=jsonb_build_array('https://ir.amd.com/fixture-release') where story_key=$1",[key(2)]);
 const recovered=await service(true).runInvocation();
 assert.equal(historyCalls,2,'Actual 55P03 response is retried after writer commits');assert.equal(sourceCalls,1,'Source work starts only after complete history succeeds');assert.equal(recovered.reason,'evidence_or_history_unavailable');assert.equal(paidCalls,0);
 const after=await history();assert.notEqual(after.snapshotHash,before.snapshotHash);assert.equal(after.items[0].candidateContext[0].text,'Changed historical context');
 await writer.query('begin');await writer.query('select 1 from public.warpcore_stories where story_key=$1 for update',[historical]);
 historyCalls=0;sourceCalls=0;const exhausted=await service(false).runInvocation();
 assert.equal(historyCalls,3);assert.equal(exhausted.reason,'history_lock_contention');assert.equal(sourceCalls,0);assert.equal(paidCalls,0);await writer.query('rollback');
 // Shared admission contention uses the same safe recovery classification.
 await writer.query('begin');await writer.query("select pg_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0))");await assert.rejects(history,e=>e.code==='55P03');await writer.query('rollback');
 // Retry does not weaken currentness checks or create duplicate durable admission.
 const proposal=await material(key(2)),receipt=await issue(proposal);assert.equal(await issue(proposal),receipt);
 const admitted=await submit(receipt);assert.equal(await submit(receipt),admitted);
 assert.equal((await q('select count(*)::int n from agent_verification.receipts where id=$1',[receipt]))[0].n,1);
 assert.equal((await q('select count(*)::int n from public.warpcore_curator_inbox where verification_receipt_id=$1',[receipt]))[0].n,1);
 await q("update public.warpcore_candidates set text='Changed after receipt' where story_key=$1",[key(2)]);
 assert.equal(await scalar('select agent_verification.receipt_current($1) value',[receipt]),false);
 assert.equal((await q('select count(*)::int n from public.warpcore_publications'))[0].n,0);
 assert.ok(inbox);console.log('PASS actual PostgreSQL history NOWAIT conflict, transport/runtime bounded retry recovery and exhaustion, advisory contention, currentness and duplicate admission guards; no paid requests or publications');
}finally{
 await Promise.all([writer.query('rollback').catch(()=>{}),reader.query('rollback').catch(()=>{})]);
 await Promise.all([writer.end().catch(()=>{}),reader.end().catch(()=>{})]);
}
