import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();const q=async(s,a=[])=>(await db.query(s,a)).rows;const value=async(s,a=[])=> (await q(s,a))[0].v;
const root='00000000-0000-4000-8000-000000000001',key='a'.repeat(64),hash='b'.repeat(64);
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await db.exec(`create table shadow_agent.ranking_runs(run_id uuid primary key,finalized_at timestamptz);create table shadow_agent.candidates(run_id uuid,ordinal bigint,candidate_id text);create table shadow_agent.selection_items(run_id uuid,ordinal bigint,rank int);
 create table public.warpcore_curator_inbox(id uuid primary key default gen_random_uuid(),verification_receipt_id uuid unique,story_key text,run_id uuid,actor_kind text);create schema agent_verification;create table agent_verification.receipts(id uuid primary key,material jsonb);create function agent_verification.receipt_current(uuid) returns boolean language sql as 'select true';`);
 await q("insert into shadow_agent.runs(id,state,limit_credits) values($1,'{\"phase\":\"complete\"}',1)",[root]);await q('insert into shadow_agent.ranking_runs values($1,now())',[root]);await q('insert into shadow_agent.candidates values($1,0,$2)',[root,key]);await q('insert into shadow_agent.selection_items values($1,0,1)',[root]);
 await db.exec(`create function public.warpcore_agent_submit(p_id uuid) returns uuid language sql as 'insert into public.warpcore_curator_inbox(verification_receipt_id,story_key,run_id,actor_kind) select p_id,material->>''storyKey'',(material->>''runId'')::uuid,''agent'' from agent_verification.receipts where id=p_id returning id';`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-jobs.sql',import.meta.url),'utf8'));
 const claim=()=>value('select public.warpcore_verification_claim() v');assert.equal(await claim(),null);assert.equal((await q('select count(*)::int n from shadow_agent.budgets'))[0].n,0);
 assert.equal((await q('select submit_enabled from shadow_agent.verification_settings'))[0].submit_enabled,false,'Live verification defaults to nonpublishing preview');
 await db.exec('update shadow_agent.verification_settings set enabled=true,submit_enabled=true,job_limit_credits=0.2');const job=await claim();assert.equal(job.storyKey,key);assert.equal(job.rankingRunId,root);assert.equal(await claim(),null);
 const reserve=(lease=job.lease,metadata={model:'openai/gpt-oss-120b',profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'})=>value('select public.warpcore_verification_reserve($1,$2,$3,0.1,$4) v',[job.jobId,lease,hash,metadata]);
 await assert.rejects(()=>reserve(),/Missing daily budget/);await db.exec("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
 await assert.rejects(()=>reserve(job.lease,{model:'other',profileVersion:'2026-11-16.verify.1',expectedProvider:'Groq'}),/metadata/);
 const attempt=await reserve();assert.ok(attempt);await assert.rejects(()=>reserve(),/already reserved/);
 assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[job.jobId,job.lease]),true);assert.equal(await value('select public.warpcore_verification_dispatch($1,$2) v',[job.jobId,job.lease]),false);
 const receipt='00000000-0000-4000-8000-000000000002';await q('insert into agent_verification.receipts values($1,$2)',[receipt,{runId:root,storyKey:key,requestSha256:hash,model:'openai/gpt-oss-120b',requestProfileVersion:'2026-11-16.verify.1'}]);
 await assert.rejects(()=>value("select public.warpcore_verification_finish($1,$2,'verified',$3) v",[job.jobId,job.lease,receipt]),/[Ss]ettled/);
 const audit={model:'openai/gpt-oss-120b',provider:'Groq',generationId:'gen-fixture',usage:{promptTokens:10,completionTokens:5,totalTokens:15,costCredits:0.01}};
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
 await value('select public.warpcore_verification_reserve($1,$2,$3,0.1,$4) v',[fresh.jobId,fresh.lease,'d'.repeat(64),meta]);
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
 const recovered=await claim();assert.equal(recovered.jobId,fresh.jobId);assert.equal(recovered.handoffReceiptId,good);
 assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,fresh.lease]),null,'Old handoff lease cannot submit');
 const handed=await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,recovered.lease]);assert.ok(handed);assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[fresh.jobId,recovered.lease]),handed);
 const fetchFail=await nextStory('e',2);await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[fetchFail.jobId]);const resumed=await claim();assert.equal(resumed.jobId,fetchFail.jobId);assert.notEqual(resumed.lease,fetchFail.lease);
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'deferred',null) v",[resumed.jobId,resumed.lease]),true,'Fetch failure needs no paid attempt');
 const billedBad=await nextStory('9',3);await value('select public.warpcore_verification_reserve($1,$2,$3,0.1,$4) v',[billedBad.jobId,billedBad.lease,'8'.repeat(64),meta]);await value('select public.warpcore_verification_dispatch($1,$2) v',[billedBad.jobId,billedBad.lease]);
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
 const unknown=await nextStory('f',4);await value('select public.warpcore_verification_reserve($1,$2,$3,0.1,$4) v',[unknown.jobId,unknown.lease,'1'.repeat(64),meta]);await value('select public.warpcore_verification_dispatch($1,$2) v',[unknown.jobId,unknown.lease]);
 for(const httpStatus of [400,402,429,500,503]){await db.exec('begin');assert.equal(await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic:{httpStatus}}]),true);assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,.1);await db.exec('rollback');}
 await value("select public.warpcore_verification_settle($1,$2,'uncertain',null,$3) v",[unknown.jobId,unknown.lease,{errorCode:'http_failure',diagnostic:{httpStatus:429}}]);
 assert.equal((await q('select held_credits::float8 n from shadow_agent.budgets'))[0].n,0.1);assert.equal(await claim(),null);
 assert.equal(await value("select public.warpcore_verification_finish($1,$2,'deferred',null) v",[unknown.jobId,unknown.lease]),false,'Unknown outcome cannot become deferred');
 // Authoritatively stale recovered receipts stop handoff, preserving paid audit.
 await q("update shadow_agent.verification_jobs set status='verified',receipt_id=$2 where id=$1",[job.jobId,receipt]);
 await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=(select child_run_id from shadow_agent.verification_jobs where id=$1)",[job.jobId]);
 await db.exec("create or replace function agent_verification.receipt_current(uuid) returns boolean language sql as 'select false'");
 const staleRecovery=await claim();assert.equal(staleRecovery.jobId,job.jobId);assert.equal(await value('select public.warpcore_verification_handoff($1,$2) v',[job.jobId,staleRecovery.lease]),null);
 assert.deepEqual((await q('select status,handoff_status,handoff_reason from shadow_agent.verification_jobs where id=$1',[job.jobId]))[0],{status:'verified',handoff_status:'deferred',handoff_reason:'stale_receipt'});
 for(const role of ['anon','authenticated','service_role']){await db.exec(`set role ${role}`);for(const table of ['verification_settings','verification_jobs','verification_audit','budgets'])await assert.rejects(()=>q('select * from shadow_agent.'+table),/permission/);
 if(role!=='service_role')assert.equal((await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'warpcore_verification_%' and has_function_privilege(current_user,p.oid,'execute')`))[0].n,0);if(role!=='service_role')await assert.rejects(()=>claim(),/permission/);await db.exec('reset role');}
 console.log('PASS: selected-only durable verifier job, disabled defaults, shared budgets, exact metadata, no paid replay and late accounting/finish fencing');
}finally{await db.close();}
