import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,v=async(s,a=[])=>(await q(s,a))[0]?.v;
const run='00000000-0000-4000-8000-000000000001',job='00000000-0000-4000-8000-000000000002',attempt='00000000-0000-4000-8000-000000000003',lease='00000000-0000-4000-8000-000000000004';
try{
 await db.exec('create role anon;create role authenticated;create role service_role');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await db.exec(`create table shadow_agent.verification_jobs(id uuid primary key,child_run_id uuid,story_key text,status text,metadata jsonb,receipt_id uuid,handoff_inbox_id uuid);
 create table shadow_agent.verification_audit(job_id uuid,status text,audit jsonb);
 create schema agent_verification;create table agent_verification.receipts(material jsonb);
 create table public.warpcore_curator_inbox(story_key text);create table public.warpcore_publications(story_key text);
 create table shadow_agent.runtime_settings(singleton boolean,model text);
 insert into shadow_agent.runtime_settings values(true,'openai/gpt-oss-120b');
 create function shadow_agent.approved_runtime_model(text) returns jsonb language sql as 'select case when $1 in (''openai/gpt-oss-120b'',''nvidia/nemotron-3.5-super-vl'') then jsonb_build_object(''model'',$1,''provider'',case when $1=''openai/gpt-oss-120b'' then ''Cerebras'' else ''Together'' end) end';
 create function shadow_agent.verification_lock() returns void language sql as 'select';`);
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/verification-quarantine.sql',import.meta.url),'utf8'));
 await q(`insert into shadow_agent.budgets values((now() at time zone 'utc')::date,2,.157287,.03,false)`);
 await q(`insert into shadow_agent.runs(id,state,revision,limit_credits,held_credits,spent_credits,lease_token,lease_until) values($1,$2,7,1,.157287,.02,$3,now()-interval '1 minute')`,[run,{storageKind:'verification-v1',runId:run,phase:'reviewing',revision:7,activeBatch:['a'.repeat(64)],publishingEnabled:false},lease]);
 await q(`insert into shadow_agent.attempts values($1,$2,(now() at time zone 'utc')::date,$3,$4,.157287,'uncertain',null,7)`,[attempt,run,lease,'b'.repeat(64)]);
 await q(`insert into shadow_agent.verification_jobs(id,child_run_id,story_key,status,metadata) values($1,$2,$3,'uncertain',$4)`,[job,run,'a'.repeat(64),{model:'nvidia/nemotron-3.5-super-vl',expectedProvider:'Together',profileVersion:'2026-11-16.verify.1'}]);
 await q(`insert into shadow_agent.verification_audit values($1,'uncertain','{"errorCode":"timeout"}')`,[job]);
 const call=(revision=7,reason='Owner preserves unknown full hold while validating a different reviewed model',id=attempt)=>v('select shadow_agent.quarantine_verification_job($1,$2,$3,$4) v',[job,id,revision,reason]);
 const snapshot=()=>q(`select to_jsonb(r) r,to_jsonb(a) a,to_jsonb(b) b,(select jsonb_agg(to_jsonb(x)) from shadow_agent.verification_audit x) audit from shadow_agent.runs r join shadow_agent.attempts a on a.run_id=r.id join shadow_agent.budgets b on b.day=a.day`);
 for(const reason of [null,'','   ','bad\nreason','x'.repeat(1001)])await assert.rejects(()=>call(7,reason),/reason/i);
 assert.equal(await call(6),null);assert.equal(await call(7,'bounded reason','00000000-0000-4000-8000-000000000099'),null);
 async function refused(sql,pattern){await db.exec('begin');await db.exec(sql);await assert.rejects(()=>call(),pattern);await db.exec('rollback');}
 await refused(`update shadow_agent.runtime_settings set model='nvidia/nemotron-3.5-super-vl'`,/different/i);
 await refused(`update shadow_agent.runtime_settings set model='unreviewed'`,/reviewed/i);
 await refused(`update shadow_agent.attempts set status='settled',actual=.01`,/unknown/i);
 await refused(`update shadow_agent.runs set held_credits=.1`,/hold/i);
 await refused(`update shadow_agent.verification_jobs set status='pending'`,/uncertain/i);
 await refused(`update shadow_agent.verification_jobs set receipt_id=gen_random_uuid()`,/receipt|inbox/i);
 await refused(`insert into agent_verification.receipts values('{"storyKey":"${'a'.repeat(64)}"}')`,/receipt|inbox/i);
 await refused(`insert into public.warpcore_curator_inbox values('${'a'.repeat(64)}')`,/receipt|inbox/i);
 await refused(`insert into shadow_agent.verification_audit values('${job}','settled','{}')`,/unknown|settled/i);
 for(const audit of [{errorCode:'transport_failure'},{errorCode:'http_failure'},{errorCode:'http_failure',diagnostic:{httpStatus:500}}]){
  await db.exec('begin');await q('update shadow_agent.verification_audit set audit=$1',[audit]);await assert.rejects(()=>call(),/timeout|429/i);await db.exec('rollback');
 }
 await db.exec('begin');await q('update shadow_agent.verification_audit set audit=$1',[{errorCode:'http_failure',diagnostic:{httpStatus:429}}]);assert.equal((await call()).quarantined,true);await db.exec('rollback');
 // Explicit owner-reviewed V3→V4 schema rejection, same-model exception only.
 await db.exec('begin');
 await q('update shadow_agent.verification_jobs set metadata=$1',[{model:'openai/gpt-oss-120b',expectedProvider:'Cerebras',profileVersion:'2026-11-17.verify.3'}]);
 const rejectedAudit={errorCode:'http_failure',diagnostic:{httpStatus:400,providerErrorType:'invalid_request_error'}};
 await q('update shadow_agent.verification_audit set audit=$1',[rejectedAudit]);
 const manifest='c'.repeat(64),typed=(profile='2026-11-17.verify.4',sha=manifest)=>v('select shadow_agent.quarantine_rejected_verification_v3($1,$2,$3,$4,$5,$6) v',[job,attempt,7,profile,sha,'Owner verified exact deployed V4 manifest; original cost remains unknown held.']);
 async function typedRefused(sql,pattern,profile='2026-11-17.verify.4',sha=manifest){await db.exec('savepoint typed_refusal');if(sql)await db.exec(sql);await assert.rejects(()=>typed(profile,sha),pattern);await db.exec('rollback to typed_refusal');}
 await db.exec('savepoint original_refusal');await assert.rejects(()=>call(),/Different reviewed active model/);await db.exec('rollback to original_refusal');
 for(const profile of [null,'2026-11-17.verify.3','arbitrary'])await typedRefused(null,/provenance/,profile);
 for(const sha of [null,'','c'.repeat(63),'z'.repeat(64),'c'.repeat(64)+'\n'])await typedRefused(null,/provenance/,'2026-11-17.verify.4',sha);
 for(const mutate of ["update shadow_agent.verification_jobs set metadata=jsonb_set(metadata,'{profileVersion}','\"2026-11-17.verify.2\"')","update shadow_agent.verification_jobs set metadata=jsonb_set(metadata,'{expectedProvider}','\"Groq\"')","update shadow_agent.runtime_settings set model='nvidia/nemotron-3.5-super-vl'"])await typedRefused(mutate,/V3 Cerebras|reviewed/i);
 await typedRefused("update shadow_agent.verification_jobs set status='pending'",/uncertain/i);
 await typedRefused("update shadow_agent.attempts set status='settled',actual=.01",/unknown/);
 await typedRefused("update shadow_agent.runs set held_credits=.1",/hold/);
 await typedRefused("update shadow_agent.budgets set held_credits=.1",/hold/);
 await typedRefused("update shadow_agent.verification_jobs set receipt_id=gen_random_uuid()",/Receipt|inbox/);
 await typedRefused(`insert into public.warpcore_curator_inbox values('${'a'.repeat(64)}')`,/Receipt|inbox/);
 for(const bad of [{errorCode:'timeout'},{errorCode:'http_failure',diagnostic:{httpStatus:429,providerErrorType:'invalid_request_error'}},{errorCode:'http_failure',diagnostic:{httpStatus:400,providerErrorType:'permission_error'}},{errorCode:'http_failure',diagnostic:{httpStatus:400}},{...rejectedAudit,usage:{costCredits:0}}])await typedRefused('update shadow_agent.verification_audit set audit='+"'"+JSON.stringify(bad)+"'::jsonb",/Recorded HTTP 400/);
 const beforeTyped=await snapshot(),beforeJob=(await q("select to_jsonb(j)-'quarantined' value from shadow_agent.verification_jobs j"))[0].value;
 const typedResult=await typed();assert.equal(typedResult.quarantined,true);assert.equal(typedResult.replacementProfile,'2026-11-17.verify.4');assert.equal(typedResult.deploymentSha256,manifest);
 assert.deepEqual(await snapshot(),beforeTyped,'Explicit schema quarantine preserves all unknown financial and workflow history');assert.deepEqual((await q("select to_jsonb(j)-'quarantined' value from shadow_agent.verification_jobs j"))[0].value,beforeJob);
 const provenance=(await q('select * from shadow_agent.verification_quarantine_audit'))[0];assert.equal(provenance.replacement_profile_version,'2026-11-17.verify.4');assert.equal(provenance.deployment_sha256,manifest);assert.deepEqual(provenance.unknown_audit,rejectedAudit);
 assert.equal(await typed(),null);await db.exec('savepoint typed_fence');await assert.rejects(()=>v('select shadow_agent.claim($1,120) v',[run]),/Quarantined/);await db.exec('rollback to typed_fence');
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await db.exec('savepoint typed_worker');await assert.rejects(()=>typed(),/permission/);await db.exec('rollback to typed_worker');await db.exec('reset role');}
 assert.equal(await v("select shadow_agent.settle($1,$2,'settled',.01) v",[attempt,lease]),true,'Schema quarantine retains original-token late accounting');assert.equal((await q('select status from shadow_agent.verification_jobs'))[0].status,'uncertain');
 await db.exec('rollback');
 // The explicit owner mitigation may keep protocol4 while skipping another
 // oversized source before any new paid call; it never retries this old job.
 for(const failedProfile of ['2026-11-17.verify.3','2026-11-17.verify.4']){
  await db.exec('begin');await q('update shadow_agent.verification_jobs set metadata=$1',[{model:'openai/gpt-oss-120b',expectedProvider:'Cerebras',profileVersion:failedProfile}]);await q('update shadow_agent.verification_audit set audit=$1',[rejectedAudit]);
  const generic=(profile='2026-11-17.verify.4',sha=manifest)=>v('select shadow_agent.quarantine_rejected_cerebras_request($1,$2,$3,$4,$5,$6) v',[job,attempt,7,profile,sha,'Owner verified manifest rejects the prior 187k source under a 100000-byte pre-model acquisition limit without truncation; billing remains unknown, other candidates only.']);
  async function genericRefused(sql,pattern,profile='2026-11-17.verify.4',sha=manifest){await db.exec('savepoint generic_refusal');if(sql)await db.exec(sql);await assert.rejects(()=>generic(profile,sha),pattern);await db.exec('rollback to generic_refusal');}
  for(const profile of ['2026-11-17.verify.3','unreviewed'])await genericRefused(null,/provenance/,profile);
  await genericRefused(null,/provenance/,'2026-11-17.verify.4','invalid-manifest');
  await genericRefused("update shadow_agent.runs set held_credits=.1",/hold/);
  await genericRefused("update shadow_agent.verification_jobs set receipt_id=gen_random_uuid()",/receipt|inbox/i);
  await genericRefused("update shadow_agent.verification_jobs set metadata=jsonb_set(metadata,'{profileVersion}','\"2026-11-16.verify.1\"')",/V3\/V4 Cerebras/);
  await genericRefused("update shadow_agent.verification_jobs set metadata=jsonb_set(metadata,'{expectedProvider}','\"Groq\"')",/V3\/V4 Cerebras/);
  await genericRefused("update shadow_agent.runtime_settings set model='nvidia/nemotron-3.5-super-vl'",/reviewed/i);
  await genericRefused(`update shadow_agent.verification_audit set audit='{"errorCode":"timeout"}'`,/Recorded HTTP 400/);
  await genericRefused(`update shadow_agent.verification_audit set audit='{"errorCode":"http_failure","diagnostic":{"httpStatus":400,"providerErrorType":"permission_error"}}'`,/Recorded HTTP 400/);
  if(failedProfile==='2026-11-17.verify.4'){await db.exec('savepoint narrow_unchanged');await assert.rejects(()=>typed(),/Exact V3 Cerebras/);await db.exec('rollback to narrow_unchanged');}
  const financialBefore=await snapshot(),jobBefore=(await q("select to_jsonb(j)-'quarantined' value from shadow_agent.verification_jobs j"))[0].value;
  assert.equal((await generic()).quarantined,true);assert.deepEqual(await snapshot(),financialBefore);assert.deepEqual((await q("select to_jsonb(j)-'quarantined' value from shadow_agent.verification_jobs j"))[0].value,jobBefore);
  const event=(await q('select * from shadow_agent.verification_quarantine_audit'))[0];assert.equal(event.job_before.metadata.profileVersion,failedProfile);assert.equal(event.replacement_profile_version,'2026-11-17.verify.4');assert.equal(event.deployment_sha256,manifest);assert.deepEqual(event.unknown_audit,rejectedAudit);
  assert.equal(await generic(),null);await db.exec('savepoint generic_fence');await assert.rejects(()=>v('select shadow_agent.claim($1,120) v',[run]),/Quarantined/);await db.exec('rollback to generic_fence');
  for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await db.exec('savepoint generic_worker');await assert.rejects(()=>generic(),/permission/);await db.exec('rollback to generic_worker');await db.exec('reset role');}
  assert.equal(await v("select shadow_agent.settle($1,$2,'settled',.01) v",[attempt,lease]),true);assert.equal((await q('select status from shadow_agent.verification_jobs'))[0].status,'uncertain');assert.equal(Number((await q('select held_credits from shadow_agent.verification_quarantine_audit'))[0].held_credits),.157287);
  await db.exec('rollback');
 }
 const before=await snapshot();const result=await call();assert.equal(result.quarantined,true);assert.deepEqual(await snapshot(),before,'All money, workflow, attempts and existing audits unchanged');
 assert.equal((await q('select status,quarantined from shadow_agent.verification_jobs'))[0].status,'uncertain');assert.equal((await q('select quarantined from shadow_agent.verification_jobs'))[0].quarantined,true);
 assert.equal(await call(),null,'Repeated owner action cannot create another audit');
 const audit=(await q('select * from shadow_agent.verification_quarantine_audit'))[0];assert.equal(audit.request_hash,'b'.repeat(64));assert.equal(Number(audit.held_credits),.157287);assert.ok(audit.performed_by);assert.ok(audit.performed_at);
 await assert.rejects(()=>db.exec('delete from shadow_agent.verification_quarantine_audit'),/immutable/i);await assert.rejects(()=>db.exec("update shadow_agent.verification_jobs set quarantined=false"),/quarantined/i);
 await assert.rejects(()=>v('select shadow_agent.claim($1,120) v',[run]),/quarantined/i);await assert.rejects(()=>db.exec("update shadow_agent.verification_jobs set status='pending'"),/quarantined/i);
 for(const role of ['anon','authenticated','service_role']){
  await db.exec('set role '+role);await assert.rejects(()=>call(),/permission/i);await assert.rejects(()=>q('select * from shadow_agent.verification_quarantine_audit'),/permission/i);await db.exec('reset role');
 }
 assert.equal(await v("select shadow_agent.settle($1,$2,'settled',.01) v",[attempt,lease]),true,'Original-token late financial settlement remains possible');
 assert.equal((await q('select status from shadow_agent.verification_jobs'))[0].status,'uncertain');assert.equal((await q('select status from shadow_agent.attempts'))[0].status,'settled');
 assert.equal(Number((await q('select held_credits from shadow_agent.runs'))[0].held_credits),0);assert.equal(Number((await q('select spent_credits from shadow_agent.runs'))[0].spent_credits),.03);assert.equal(Number((await q('select held_credits from shadow_agent.verification_quarantine_audit'))[0].held_credits),.157287,'Audit preserves original hold');
 console.log('PASS verification quarantine: owner-only immutable audit, unchanged unknown hold, workflow fence, reviewed model change, original-token late settlement');
}finally{await db.close();}
