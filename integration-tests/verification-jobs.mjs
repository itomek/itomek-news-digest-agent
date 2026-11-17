import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();const q=async(s,a=[])=>(await db.query(s,a)).rows;const value=async(s,a=[])=> (await q(s,a))[0].v;
const root='00000000-0000-4000-8000-000000000001',key='a'.repeat(64),hash='b'.repeat(64);
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await db.exec(`create table shadow_agent.ranking_runs(run_id uuid primary key,finalized_at timestamptz);create table shadow_agent.candidates(run_id uuid,ordinal bigint,candidate_id text);create table shadow_agent.decisions(run_id uuid,ordinal bigint,decision jsonb);create table public.warpcore_stories(story_key text,status text);create table public.warpcore_publications(story_key text);create table shadow_agent.selection_items(run_id uuid,ordinal bigint,rank int);
 create table public.warpcore_curator_inbox(id uuid primary key default gen_random_uuid(),verification_receipt_id uuid unique,story_key text,run_id uuid,actor_kind text);create schema agent_verification;create table agent_verification.receipts(id uuid primary key,material jsonb);create function agent_verification.receipt_current(uuid) returns boolean language sql as 'select true';`);
 await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[root]);await q('insert into shadow_agent.ranking_runs values($1,now())',[root]);await q('insert into shadow_agent.candidates values($1,0,$2)',[root,key]);await q('insert into shadow_agent.selection_items values($1,0,1)',[root]);
 await db.exec(`create function public.warpcore_agent_submit(p_id uuid) returns uuid language sql as 'insert into public.warpcore_curator_inbox(verification_receipt_id,story_key,run_id,actor_kind) select p_id,material->>''storyKey'',(material->>''runId'')::uuid,''agent'' from agent_verification.receipts where id=p_id returning id';`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-jobs.sql',import.meta.url),'utf8'));
 const claim=()=>value('select public.warpcore_verification_claim() v');assert.equal(await claim(),null);assert.equal((await q('select count(*)::int n from shadow_agent.budgets'))[0].n,0);
 assert.equal((await q('select ranking_finalized_since from shadow_agent.verification_settings'))[0].ranking_finalized_since,null,'New-job cohort boundary defaults NULL');
 assert.equal((await q('select backfill_enabled from shadow_agent.verification_settings'))[0].backfill_enabled,false,'Backfill is admin-disabled by default');
 assert.equal((await q('select submit_enabled from shadow_agent.verification_settings'))[0].submit_enabled,false,'Live verification defaults to nonpublishing preview');
 await db.exec('update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=0.3');const job=await claim();assert.equal(job.storyKey,key);
 const leaseSeconds=async id=>Number(await value('select extract(epoch from (lease_until-clock_timestamp())) v from shadow_agent.runs where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)',[id]));
 assert.ok(await leaseSeconds(job.jobId)>179,'Fresh verification gets a full180-second lease for evidence/model/settlement');assert.equal(job.rankingRunId,root);assert.equal(await claim(),null);
 const reserve=(lease=job.lease,metadata={model:'openai/gpt-oss-120b',profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'})=>value('select public.warpcore_verification_reserve($1,$2,$3,0.058983,$4) v',[job.jobId,lease,hash,metadata]);
 await assert.rejects(()=>reserve(),/Missing daily budget/);await db.exec("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
 await assert.rejects(()=>reserve(job.lease,{model:'other',profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'}),/metadata/);
 for(const profileVersion of ['2026-11-17.verify.2','2026-11-17.verify.3','2026-11-17.verify.4','2026-11-17.verify.5','2026-11-17.verify.6','2026-11-17.verify.7','2026-11-17.verify.8']){await db.exec('begin');assert.ok(await reserve(job.lease,{model:'openai/gpt-oss-120b',profileVersion,expectedProvider:'Groq'}),'Reviewed protocol retains exact approved provider/cap admission');await db.exec('rollback');}
 await assert.rejects(()=>reserve(job.lease,{model:'openai/gpt-oss-120b',profileVersion:'2026-11-17.verify.9',expectedProvider:'Groq'}),/metadata/);
 const attempt=await reserve();assert.ok(attempt);await assert.rejects(()=>reserve(),/already reserved/);
 assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[job.jobId,job.lease]),true);assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[job.jobId,job.lease]),false);
 const receipt='00000000-0000-4000-8000-000000000002';await q('insert into agent_verification.receipts values($1,$2)',[receipt,{runId:root,storyKey:key,requestSha256:hash,model:'openai/gpt-oss-120b',requestProfileVersion:'2026-11-16.verify.1'}]);
 await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[job.jobId,job.lease,receipt]),/[Ss]ettled/);
 const audit={model:'openai/gpt-oss-120b',provider:'Groq',generationId:'gen-fixture',usage:{promptTokens:10,completionTokens:5,totalTokens:15,costCredits:0.01}};
 const retainedApprove={action:'approve',editorial:{political:false,summary:'Short original summary',whyItMatters:'Useful consequence',change:'Concrete change',evidenceIds:['evidence-1']},claims:[{claim:'Concrete change',evidenceId:'evidence-1',url:'https://example.com/source',contentSha256:'c'.repeat(64),quote:'Exact public source quotation'}],publicationDate:'2026-11-17',scopeReason:'Technology',changeReason:'New detail',dedupReason:'Distinct event'};
 const holdBeforeNul=Number((await q('select held_credits from shadow_agent.budgets'))[0].held_credits);
 await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result:{action:'defer',reason:'private\u0000body'}}]),e=>e.code==='22P05');
 assert.equal(Number((await q('select held_credits from shadow_agent.budgets'))[0].held_credits),holdBeforeNul,'Unrepresentable NUL cannot mutate accounting; JS must omit optional result before SQL');
 assert.equal((await q('select count(*)::int n from shadow_agent.verification_audit'))[0].n,0,'NUL-containing public text is never persisted');
 const retainedV2={...retainedApprove,supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,{evidenceId:'evidence-1',quote:'Exact source quote for '+k}]))};delete retainedV2.claims;
 const retainedV3={...retainedV2,supports:Object.fromEntries(Object.keys(retainedV2.supports).map(k=>[k,'source-1-chunk-0001']))};
 for(const result of [retainedV3,{...retainedV3,editorial:{mode:'repost',political:false,change:'Native post',evidenceIds:['evidence-1']},supports:{change:'source-1-original-text',publicationDate:'source-1-created-at'}},retainedV2,{...retainedV2,editorial:{mode:'repost',political:false,change:'Original announcement',evidenceIds:['evidence-1']},supports:{change:retainedV2.supports.change,publicationDate:retainedV2.supports.publicationDate}}]){
  await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result}]),true);await db.exec('rollback');
 }
 for(const result of [{action:'defer',reason:'Insufficient primary evidence'},retainedApprove,{...retainedApprove,claims:Array.from({length:3},()=>({...retainedApprove.claims[0],quote:'q'.repeat(2000)}))},{...retainedApprove,publicationDate:'bad-model-date',claims:[],editorial:{...retainedApprove.editorial,political:true,evidenceIds:[]}},{...retainedApprove,editorial:{mode:'repost',political:false,change:'Original announcement',evidenceIds:['evidence-1']}}]){
  await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result}]),true);
  assert.deepEqual((await q('select audit from shadow_agent.verification_audit where job_id=$1',[job.jobId]))[0].audit.result,result);
  await db.exec('rollback');
 }
 for(const result of [{...retainedV3,supports:{...retainedV3.supports,change:retainedV2.supports.change}},{...retainedV3,supports:{...retainedV3.supports,change:'private raw response'}},{...retainedV3,supports:{...retainedV3.supports,change:'source-1-chunk-0001\n'}},{...retainedV3,supports:{...retainedV3.supports,change:'source-1-raw-0001'}},{...retainedV2,claims:[]},{...retainedV2,supports:{...retainedV2.supports,rawBody:'private'}},{...retainedV2,supports:{...retainedV2.supports,summary:{...retainedV2.supports.summary,url:'private'}}},{action:'defer',reason:'bounded',rawBody:'private'},{action:'defer',reason:'x'.repeat(1001)},{...retainedApprove,prompt:'private'},{...retainedApprove,claims:[{...retainedApprove.claims[0],headers:{Authorization:'private'}}]},{...retainedApprove,editorial:{...retainedApprove.editorial,credential:'private'}},{...retainedApprove,claims:Array(21).fill(retainedApprove.claims[0])}])await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result}]),/verification result/);
 await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result:{...retainedApprove,claims:Array.from({length:20},()=>({...retainedApprove.claims[0],claim:'c'.repeat(3000),quote:'q'.repeat(3000)}))}}]),/verification (audit|result)/);
 await db.exec('begin');await value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result:{action:'defer',reason:'First immutable explanation'}}]);
 await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,{...audit,result:{action:'defer',reason:'Changed explanation'}}]),/Immutable/);await db.exec('rollback');
 await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[job.jobId,job.lease,{errorCode:'http_failure',result:{action:'defer',reason:'not a parsed success'}}]),/verification audit/);
 await db.exec("update shadow_agent.runs set lease_until=now()-interval '1 second' where state->>'storageKind'='verification-v1'");
 assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[job.jobId,job.lease,audit]),true,'Late accounting allowed');
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[job.jobId,job.lease,receipt]),false,'Late finish fenced');
 assert.equal((await q('select spent_credits::float8 n from shadow_agent.budgets'))[0].n,0.01);assert.equal(await claim(),null,'Attempted expired work cannot replay');
 assert.equal((await q('select count(*)::int n from shadow_agent.verification_jobs'))[0].n,1);
 // Administrator fixture reconciliation releases a known-settled expired job.
 await db.exec("update shadow_agent.verification_jobs set status='deferred' where status='uncertain'");
 async function nextStory(char,ordinal){await q('insert into shadow_agent.candidates values($1,$2,$3)',[root,ordinal,char.repeat(64)]);await q('insert into shadow_agent.selection_items values($1,$2,$3)',[root,ordinal,ordinal+1]);return claim();}
 const fresh=await nextStory('c',1);assert.equal(fresh.storyKey,'c'.repeat(64));
 const meta={model:'openai/gpt-oss-120b',profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'};
 await value('select public.warpcore_verification_reserve($1,$2,$3,0.058983,$4) v',[fresh.jobId,fresh.lease,'d'.repeat(64),meta]);
 await db.exec('update shadow_agent.verification_settings set enabled=false');assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[fresh.jobId,fresh.lease]),false);await db.exec('update shadow_agent.verification_settings set enabled=true');
 await value('select public.warpcore_verification_dispatch($1,$2) v',[fresh.jobId,fresh.lease]);
 await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[fresh.jobId,fresh.lease,{...audit,apiKey:'forbidden'}]),/audit/);
 await value("select public.warpcore_verification_settle($1,$2,'settled',0.01,$3) v",[fresh.jobId,fresh.lease,audit]);
 await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[fresh.jobId,fresh.lease,receipt]),/binding/);
 const good='00000000-0000-4000-8000-000000000003';await q('insert into agent_verification.receipts values($1,$2)',[good,{runId:root,storyKey:fresh.storyKey,requestSha256:'d'.repeat(64),model:meta.model,requestProfileVersion:meta.profileVersion}]);
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[fresh.jobId,fresh.lease,good]),true);assert.equal(await value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[fresh.jobId,fresh.lease,good]),true);
 await db.exec('update shadow_agent.verification_settings set submit_enabled=false');
 assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,fresh.lease]),null);
 assert.equal(await claim(),null,'Preview receipts do not block or trigger handoff while submission is disabled');
 assert.equal((await q('select count(*)::int n from public.warpcore_curator_inbox'))[0].n,0);
 await db.exec('update shadow_agent.verification_settings set submit_enabled=true');
 await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[fresh.jobId]);
 const recovered=await claim();assert.equal(recovered.jobId,fresh.jobId);assert.ok(await leaseSeconds(recovered.jobId)>179,'Recovered handoff uses the same180-second lease');assert.equal(recovered.handoffReceiptId,good);
 assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,fresh.lease]),null,'Old handoff lease cannot submit');
 const handed=await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,recovered.lease]);assert.ok(handed);assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,recovered.lease]),handed);
 const fetchFail=await nextStory('e',2);await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[fetchFail.jobId]);const resumed=await claim();assert.equal(resumed.jobId,fetchFail.jobId);assert.notEqual(resumed.lease,fetchFail.lease);
 for(const [model,cap,expectedProvider] of [['meta-llama/llama-4-maverick',.216269,'Parasail'],['nvidia/nemotron-3.5-super-vl',.157287,'Together'],['nvidia/nemotron-3-super-120b-a12b',.026215,'DeepInfra']])await assert.rejects(()=>value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,{model,expectedProvider,profileVersion:'2026-11-17.verify.7'}]),/metadata/);
 for(const [model,cap,expectedProvider] of [['google/gemma-4-26b-a4b-it',.036045,'PrimeIntellect'],['openai/gpt-oss-120b',.076596,'Cerebras']]){
  const nm={model,profileVersion:model==='google/gemma-4-26b-a4b-it'?'2026-11-17.verify.8':meta.profileVersion,expectedProvider};
  await assert.rejects(()=>value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,.058983,nm]),/metadata/);
  await assert.rejects(()=>value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,{...nm,expectedProvider:'Groq'}]),/metadata/);
  if(model==='google/gemma-4-26b-a4b-it')for(const profileVersion of ['2026-11-17.verify.8']){await db.exec('begin');assert.ok(await value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,{...nm,profileVersion}]));await db.exec('rollback');}
  if(model==='google/gemma-4-26b-a4b-it')await assert.rejects(()=>value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,{...nm,profileVersion:'2026-11-16.verify.1'}]),/metadata/);
  await db.exec('begin');await value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,nm]);assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[resumed.jobId,resumed.lease]),true);
  if(model==='google/gemma-4-26b-a4b-it'){
   await db.exec('savepoint route_validation');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',.01,$3) v",[resumed.jobId,resumed.lease,{...audit,model,provider:'Other',validationError:'invalid_completion'}]),true,'Known wrong-route Meta usage is still accounted');
   await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[resumed.jobId,resumed.lease,good]),/paid validation blocked/);await db.exec('rollback to route_validation');
  }
  assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',.01,$3) v",[resumed.jobId,resumed.lease,{...audit,model,provider:expectedProvider}]),true);
  const nr=await value('insert into agent_verification.receipts values(gen_random_uuid(),$1) returning id v',[{runId:root,storyKey:resumed.storyKey,requestSha256:hash,model,requestProfileVersion:nm.profileVersion}]);assert.equal(await value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[resumed.jobId,resumed.lease,nr]),true);await db.exec('rollback');
  if(model==='google/gemma-4-26b-a4b-it'){
   await db.exec('begin');const heldBefore=Number((await q('select held_credits from shadow_agent.budgets'))[0].held_credits);await value('select public.warpcore_verification_reserve($1,$2,$3,$4,$5) v',[resumed.jobId,resumed.lease,hash,cap,nm]);await value('select public.warpcore_verification_dispatch($1,$2) v',[resumed.jobId,resumed.lease]);
   assert.equal(await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[resumed.jobId,resumed.lease,{errorCode:'http_failure',diagnostic:{httpStatus:429,errorProvider:'PrimeIntellect'}}]),true);assert.equal(Number((await q('select held_credits from shadow_agent.budgets'))[0].held_credits),heldBefore+cap,'Unknown PrimeIntellect outcome retains complete reservation');assert.equal(await claim(),null,'Unknown new route cannot replay');await db.exec('rollback');
  }

 }
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'deferred',null) v",[resumed.jobId,resumed.lease]),true,'Fetch failure needs no paid attempt');
 const billedBad=await nextStory('9',3);await value('select public.warpcore_verification_reserve($1,$2,$3,0.058983,$4) v',[billedBad.jobId,billedBad.lease,'8'.repeat(64),meta]);await value('select public.warpcore_verification_dispatch($1,$2) v',[billedBad.jobId,billedBad.lease]);
 for(const diagnostic of [{body:'forbidden'},{message:'forbidden'},{headers:{Authorization:'forbidden'}},{apiKey:'forbidden'},{generationId:'x'.repeat(257)},{model:'x'.repeat(129)},{provider:'bad\nprovider'},{provider:'bad\u0085provider'},{httpStatus:99},{httpStatus:600},{httpStatus:429.5},{validationIssue:'private error text'},{decisionIndex:-1},{decisionIndex:100},{decisionIndex:0.5},{}])await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[billedBad.jobId,billedBad.lease,{errorCode:'http_failure',diagnostic}]),/diagnostic/);
 await db.exec('begin');
 const identityIncomplete={usage:audit.usage,errorCode:'invalid_completion',diagnostic:{generationId:'gen-valid-despite-invalid-provider',model:meta.model}};
 assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',.01,$3) v",[billedBad.jobId,billedBad.lease,identityIncomplete]),true,'Malformed provider cannot erase known billed cost');assert.equal(Number((await q('select spent_credits from shadow_agent.budgets'))[0].spent_credits),.03);
 await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[billedBad.jobId,billedBad.lease,good]),/paid validation blocked/);await db.exec('rollback');
 const badAudit={...audit,provider:'Other',validationError:'invalid_completion',usage:{...audit.usage,costCredits:0.11},diagnostic:{generationId:'gen-fixture',model:meta.model,provider:'Other',httpStatus:200,validationIssue:'invalid_shape',decisionIndex:0}};
 assert.equal(await value("select public.warpcore_verification_settle($1,$2,'settled',0.11,$3) v",[billedBad.jobId,billedBad.lease,badAudit]),true,'Known billed invalid route still accounts actual cost');
 assert.equal((await q('select blocked from shadow_agent.budgets'))[0].blocked,true,'Reservation overrun blocks spending');
 await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[billedBad.jobId,billedBad.lease,good]),/paid validation blocked/);
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'deferred',null) v",[billedBad.jobId,billedBad.lease]),true,'Known model validation failure can defer');
 // Separate synthetic campaign fixture; administrative unblock only for unknown-hold test.
 await db.exec('update shadow_agent.budgets set blocked=false');
 const unknown=await nextStory('f',4);await value('select public.warpcore_verification_reserve($1,$2,$3,0.058983,$4) v',[unknown.jobId,unknown.lease,'1'.repeat(64),meta]);await value('select public.warpcore_verification_dispatch($1,$2) v',[unknown.jobId,unknown.lease]);
 const bounded429={httpStatus:429,providerErrorCode:429,providerErrorType:'rate_limit_exceeded',errorProvider:'DeepInfra',limitSource:'upstream_provider_shared_pool',retryAfterSeconds:60,requestId:'req-diagnostic_42',cloudflareRay:'0123456789abcdef-ORD'};
 for(const diagnostic of [{...bounded429,message:'raw body'},{...bounded429,prompt:'private prompt'},{...bounded429,providerErrorCode:'private secret error'},{...bounded429,providerErrorCode:418},{...bounded429,providerErrorType:'private detail'},{...bounded429,errorProvider:'wrong'},{...bounded429,limitSource:'private limit'},{...bounded429,retryAfterSeconds:86401},{...bounded429,retryAfterSeconds:-1},{...bounded429,retryAfterSeconds:1.5},{...bounded429,requestId:'secret header text'},{...bounded429,requestId:'gen-'+ 'x'.repeat(125)},{...bounded429,cloudflareRay:'private header'},{...bounded429,requestId:'req-valid\n'},{...bounded429,cloudflareRay:'0123456789abcdef-ORD\n'},{...bounded429,providerErrorCode:'429'}])await assert.rejects(()=>value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic}]),/diagnostic/);
 for(const diagnostic of [{...bounded429,providerErrorCode:'engine_overloaded'},{...bounded429,errorProvider:'Together'},{...bounded429,errorProvider:'Cerebras'},{...bounded429,errorProvider:'PrimeIntellect'},{...bounded429,providerErrorCode:'RESOURCE_EXHAUSTED',providerErrorType:'provider_unavailable',errorProvider:'Google AI Studio',limitSource:'openrouter_credits',retryAfterSeconds:0,requestId:'gen-diagnostic_42'},{...bounded429,retryAfterSeconds:86400,requestId:'req_diagnostic_42'}]){await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic}]),true);await db.exec('rollback');}
 await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic:bounded429}]),true);assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,.058983);await db.exec('rollback');
 for(const httpStatus of [400,402,429,500,503]){await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic:{httpStatus}}]),true);assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,.058983);await db.exec('rollback');}
 await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic:{httpStatus:429}}]);
 assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,0.058983);assert.equal(await claim(),null);
 await db.exec('begin');await q('update shadow_agent.verification_jobs set quarantined=true where id=$1',[unknown.jobId]);
 const successor=await nextStory('8',99);assert.ok(successor,'Only owner-quarantined unknown jobs stop blocking different durable work');
 assert.equal((await q('select status from shadow_agent.verification_jobs where id=$1',[unknown.jobId]))[0].status,'uncertain');
 assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,.058983,'Ignoring quarantined work never releases its hold');await db.exec('rollback');
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'deferred',null) v",[unknown.jobId,unknown.lease]),false,'Unknown outcome cannot become deferred');
 // Authoritatively stale recovered receipts stop handoff, preserving paid audit.
 await q("update shadow_agent.verification_jobs set status='verified',receipt_id=$2 where id=$1",[job.jobId,receipt]);
 await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[job.jobId]);
 await db.exec("create or replace function agent_verification.receipt_current(uuid) returns boolean language sql as 'select false'");
 const staleRecovery=await claim();assert.equal(staleRecovery.jobId,job.jobId);assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[job.jobId,staleRecovery.lease]),null);
 assert.deepEqual((await q('select status,handoff_status,handoff_reason from shadow_agent.verification_jobs where id=$1',[job.jobId]))[0],{status:'verified',handoff_status:'deferred',handoff_reason:'stale_receipt'});
 // Frozen-score fallthrough uses existing jobs as the durable attempted set.
 await db.exec('begin');
 const backfillRun='00000000-0000-4000-8000-000000000050';
 await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[backfillRun]);await q("insert into shadow_agent.ranking_runs values($1,'2000-01-01')",[backfillRun]);
 for(let n=1;n<=8;n++){
  const story=n.toString(16).padStart(64,'0');await q('insert into shadow_agent.candidates values($1,$2,$3)',[backfillRun,n,story]);
  await q('insert into shadow_agent.decisions values($1,$2,$3)',[backfillRun,n,{action:'verify',importance:n===6?3:4,relevance:n<=5?4:1}]);await q("insert into public.warpcore_stories values($1,'unverified_review_required')",[story]);
  if(n<=5){await q('insert into shadow_agent.selection_items values($1,$2::bigint,$2::int)',[backfillRun,n]);const child=(await q("insert into shadow_agent.runs(id,state,limit_credits) values(gen_random_uuid(),'{}',1) returning id"))[0].id;await q("insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id,status) values($1,$2,$3,'deferred')",[backfillRun,story,child]);}
 }
 const next=()=>q('select * from shadow_agent.next_verification_candidate()');
 assert.deepEqual(await next(),[],'Disabled backfill never extends original immutable shortlist');
 await db.exec('update shadow_agent.verification_settings set backfill_enabled=true');
 assert.equal((await next())[0]?.story_key,'7'.padStart(64,'0'),'Frozen importance before relevance, deterministic story ID tie');
 await q('insert into public.warpcore_publications values($1)',['7'.padStart(64,'0')]);assert.equal((await next())[0]?.story_key,'8'.padStart(64,'0'),'Already published stories excluded');
 await q('insert into public.warpcore_curator_inbox(story_key) values($1)',['8'.padStart(64,'0')]);assert.equal((await next())[0]?.story_key,'6'.padStart(64,'0'),'Already queued stories excluded');
 await db.exec("update shadow_agent.verification_jobs set status='deferred' where status='uncertain'");const sixth=await claim();assert.equal(sixth.storyKey,'6'.padStart(64,'0'),'Claim shares exact live-excluded helper candidate');
 assert.deepEqual(await next(),[],'Finite live-eligible unattempted candidate pool is exhausted independently of qualified cap');
 assert.equal((await q("select count(*)::int n from shadow_agent.verification_jobs where ranking_run_id=$1 and status='verified'",[backfillRun]))[0].n,0,'Exhaustion is not five-qualified completion');
 await q('update shadow_agent.verification_settings set ranking_finalized_since=(select finalized_at from shadow_agent.ranking_runs where run_id=$1)',[backfillRun]);
 await q("update shadow_agent.verification_jobs set status='verified',handoff_status='deferred' where ranking_run_id=$1 and story_key<>$2",[backfillRun,sixth.storyKey]);
 assert.deepEqual(await next(),[],'With cohort pinned, five verified stories including stale historical handoffs still consume the full run cap');
 await db.exec('savepoint cap_check');await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[sixth.jobId,sixth.lease,receipt]),/qualified limit/);await db.exec('rollback to cap_check');
 assert.equal((await q('select count(*)::int n from shadow_agent.selection_items where run_id=$1',[backfillRun]))[0].n,5,'Original proposals remain five unchanged');
 await db.exec('rollback');
 // Cohort filtering affects only new jobs; durable historical work survives.
 await db.exec('begin');
 const cohortRuns=['00000000-0000-4000-8000-000000000060','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000062'],boundary='2026-11-17T07:10:11.123456Z';
 for(const [n,id] of cohortRuns.entries()){await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[id]);await q("insert into shadow_agent.ranking_runs values($1,$2::timestamptz+($3::int-1)*interval '1 microsecond')",[id,boundary,n]);await q('insert into shadow_agent.candidates values($1,0,$2)',[id,(100+n).toString(16).padStart(64,'0')]);await q('insert into shadow_agent.selection_items values($1,0,1)',[id]);}
 const cohortNext=()=>q('select * from shadow_agent.next_verification_candidate()');
 assert.equal((await cohortNext())[0].ranking_run_id,cohortRuns[0],'NULL preserves oldest historical eligible run');
 await q('update shadow_agent.verification_settings set ranking_finalized_since=(select finalized_at from shadow_agent.ranking_runs where run_id=$1)',[cohortRuns[1]]);
 assert.equal((await cohortNext())[0].ranking_run_id,cohortRuns[1],'Exact stored microsecond boundary includes current run and excludes older history');
 await q("update shadow_agent.verification_settings set ranking_finalized_since=$1::timestamptz+interval '1 microsecond'",[boundary]);assert.equal((await cohortNext())[0].ranking_run_id,cohortRuns[2],'Future finalized complete cohort remains eligible');
 await q("update shadow_agent.runs set state='{\"phase\":\"review\"}' where id=$1",[cohortRuns[2]]);assert.deepEqual(await cohortNext(),[],'Future incomplete work cannot enter cohort verification');await q("update shadow_agent.runs set state='{\"phase\":\"complete\"}' where id=$1",[cohortRuns[2]]);
 await q('update shadow_agent.verification_settings set ranking_finalized_since=(select finalized_at from shadow_agent.ranking_runs where run_id=$1)',[cohortRuns[1]]);
 const financialBefore=await q('select * from shadow_agent.budgets');assert.equal(await claim(),null,'Historical unknown job still blocks new cohort work');assert.deepEqual(await q('select * from shadow_agent.budgets'),financialBefore);
 await q("update shadow_agent.verification_jobs set quarantined=true where status='uncertain'");
 const oldChild='00000000-0000-4000-8000-000000000063';await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,$2,1)",[oldChild,{storageKind:'verification-v1',runId:oldChild,phase:'reviewing',revision:0,activeBatch:['64'.padStart(64,'0')],publishingEnabled:false}]);
 const oldJob=(await q("insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id) values($1,$2,$3) returning id",[cohortRuns[0],'64'.padStart(64,'0'),oldChild]))[0].id;
 const resumedOld=await claim();assert.equal(resumedOld.jobId,oldJob,'Existing old unattempted pending job retains priority despite cutoff');assert.equal(resumedOld.rankingRunId,cohortRuns[0]);
 await q("update shadow_agent.verification_jobs set status='verified',receipt_id=$2 where id=$1",[oldJob,receipt]);await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[oldChild]);const recoveredOld=await claim();assert.equal(recoveredOld.jobId,oldJob);assert.equal(recoveredOld.handoffReceiptId,receipt,'Historical receipt recovery is never filtered by cutoff');
 await q("update shadow_agent.verification_jobs set handoff_status='deferred' where id=$1",[oldJob]);const cohortJob=await claim();assert.equal(cohortJob.rankingRunId,cohortRuns[1],'Only new job allocation uses the current cohort');assert.deepEqual(await q('select * from shadow_agent.budgets'),financialBefore,'Cohort selection never changes money');
 await db.exec('rollback');
 for(const role of ['anon','authenticated','service_role']){await db.exec(`set role ${role}`);await assert.rejects(()=>q('select * from shadow_agent.next_verification_candidate()'),/permission/);await assert.rejects(()=>q('select ranking_finalized_since from shadow_agent.verification_settings'),/permission/);await assert.rejects(()=>q('update shadow_agent.verification_settings set ranking_finalized_since=now()'),/permission/);for(const table of ['verification_settings','verification_jobs','verification_audit','budgets'])await assert.rejects(()=>q('select * from shadow_agent.'+table),/permission/);
 if(role!=='service_role')assert.equal((await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'warpcore_verification_%' and has_function_privilege(current_user,p.oid,'execute')`))[0].n,0);if(role!=='service_role')await assert.rejects(()=>claim(),/permission/);await db.exec('reset role');}
 console.log('PASS: selected-only durable verifier job, disabled defaults, shared budgets, exact metadata, no paid replay and late accounting/finish fencing');
}finally{await db.close();}
