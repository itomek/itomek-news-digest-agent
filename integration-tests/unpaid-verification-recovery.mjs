import {PGlite} from '@electric-sql/pglite';import assert from 'node:assert/strict';import {setup,fixture} from './unpaid-verification-fixture.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,v=async(s,a=[])=>(await q(s,a))[0].v;
try{
 await setup(db);const f=await fixture(db);
 const claim=()=>v('select public.warpcore_verification_claim() v');
 const job=await claim();assert.equal(job?.jobId,f.job,'Normal idle claim reopens one due unpaid source failure');
 const run=(await q('select * from shadow_agent.runs where id=$1',[f.child]))[0];assert.equal(run.revision,2);assert.equal(run.state.phase,'reviewing');assert.deepEqual(run.state.activeBatch,[f.story]);assert.equal(run.state.revision,2);assert.notEqual(job.lease,f.oldLease);
 assert.equal(await v("select public.warpcore_verification_finish($1,$2,'deferred',null,'source_timeout') v",[f.job,f.oldLease]),false,'Old worker finish is fenced');
 assert.equal((await q('select count(*)::int n from shadow_agent.attempts'))[0].n,0,'Recovery never reserves a paid call');
 const audit=(await q('select * from shadow_agent.verification_source_retry_audit'))[0];assert.equal(audit.retry_number,1);assert.equal(audit.outcome_reason,'source_timeout');assert.equal(audit.revision_before,1);assert.equal(audit.run_before.state.phase,'deferred');
 await assert.rejects(q('delete from shadow_agent.verification_source_retry_audit'),/immutable/i);
 assert.equal(await claim(),null,'Active replacement lease prevents concurrent reuse');
 assert.equal(await v("select public.warpcore_verification_finish($1,$2,'deferred',null,'source_timeout') v",[f.job,job.lease]),true);
 await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[f.child]);await q("update shadow_agent.health_progress set progressed_at=now() where entity_id=$1",[f.job]);
 assert.equal(await claim(),null,'Fresh failure must back off at least15minutes');
 await db.exec("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
 const ledger=async()=>await q("select (select jsonb_agg(to_jsonb(a) order by id) from shadow_agent.attempts a) attempts,(select jsonb_agg(to_jsonb(b) order by day) from shadow_agent.budgets b) budgets");
 for(const status of ['reserved','dispatched','settled','uncertain']){
  await db.exec('begin');const paid=await fixture(db);
  await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,status,checkpoint_revision,actual) values($1,(now() at time zone 'utc')::date,$2,repeat('b',64),.036045,$3,1,$4)",[paid.child,paid.oldLease,status,status==='settled'?.001:null]);
  const before=await ledger();assert.equal(await claim(),null,status+' attempt can never be retried');assert.deepEqual(await ledger(),before);await db.exec('rollback');
 }
 for(const status of ['reserved','dispatched','uncertain'])for(const kind of ['verification sibling','discovery capture']){
  await db.exec('begin');const own=await fixture(db),sibling=await fixture(db);
  if(kind==='verification sibling')await q("update shadow_agent.verification_jobs set story_key=$1 where id=$2",[own.story,sibling.job]);
  else await q("insert into shadow_agent.candidates(run_id,ordinal,candidate_id) values($1,0,$2)",[sibling.child,own.story]);
  await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,status,checkpoint_revision) values($1,(now() at time zone 'utc')::date,$2,repeat('c',64),.036045,$3,1)",[sibling.child,sibling.oldLease,status]);
  const before=await ledger();assert.equal(await claim(),null,kind+' '+status+' hold prevents retry');assert.deepEqual(await ledger(),before);await db.exec('rollback');
 }
 await db.exec('begin');const unpaid=await fixture(db),settledSibling=await fixture(db);await q('update shadow_agent.verification_jobs set story_key=$1 where id=$2',[unpaid.story,settledSibling.job]);await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,status,checkpoint_revision,actual) values($1,(now() at time zone 'utc')::date,$2,repeat('e',64),.036045,'settled',1,.001)",[settledSibling.child,settledSibling.oldLease]);assert.equal(await claim(),null,'Settled billed sibling verification is never rewrapped as an unpaid retry');await db.exec('rollback');
 await db.exec('begin');const unpaid2=await fixture(db),auditedSibling=await fixture(db);await q('update shadow_agent.verification_jobs set story_key=$1 where id=$2',[unpaid2.story,auditedSibling.job]);await q("insert into shadow_agent.verification_audit values($1,'settled','{}')",[auditedSibling.job]);assert.equal(await claim(),null,'Sibling paid verification audit prevents retry');await db.exec('rollback');
 await db.exec('begin');const normal=await fixture(db);await q('insert into shadow_agent.candidates(run_id,ordinal,candidate_id) values($1,0,$2)',[normal.parent,normal.story]);await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,status,checkpoint_revision,actual) values($1,(now() at time zone 'utc')::date,$2,repeat('f',64),.036045,'settled',0,.001)",[normal.parent,normal.oldLease]);assert.equal((await claim()).jobId,normal.job,'Normally settled parent discovery remains eligible for first unpaid verification');await db.exec('rollback');
 await db.exec('begin');const own=await fixture(db),unknown=await fixture(db);await q("update shadow_agent.verification_jobs set story_key=$1,status='uncertain' where id=$2",[own.story,unknown.job]);assert.equal(await claim(),null,'Unknown sibling job status remains fenced even without a visible attempt');await db.exec('rollback');
 const refusals={
  'model rejection':async f=>q("update shadow_agent.verification_jobs set outcome_reason='model_deferred' where id=$1",[f.job]),
  'parser failure':async f=>q("update shadow_agent.verification_jobs set outcome_reason='source_parser_failure' where id=$1",[f.job]),
  'unknown creation':async f=>q('update shadow_agent.health_progress set created_at=null where entity_id=$1',[f.job]),
  'old creation':async f=>q("update shadow_agent.health_progress set created_at=now()-interval '25 hours' where entity_id=$1",[f.job]),
  'unknown failure':async f=>q('update shadow_agent.health_progress set progressed_at=null where entity_id=$1',[f.job]),
  'fresh failure':async f=>q('update shadow_agent.health_progress set progressed_at=now() where entity_id=$1',[f.job]),
  'live lease':async f=>q("update shadow_agent.runs set lease_until=now()+interval '1 minute' where id=$1",[f.child]),
  'blocked child':async f=>q('update shadow_agent.runs set blocked=true where id=$1',[f.child]),
  'unknown money':async f=>q('update shadow_agent.runs set held_credits=.036045 where id=$1',[f.child]),
  'spent money':async f=>q('update shadow_agent.runs set spent_credits=.001 where id=$1',[f.child]),
  'metadata':async f=>q("update shadow_agent.verification_jobs set metadata='{}' where id=$1",[f.job]),
  'quarantined':async f=>q('update shadow_agent.verification_jobs set quarantined=true where id=$1',[f.job]),
  'handoff already submitted':async f=>q("update shadow_agent.verification_jobs set handoff_status='submitted' where id=$1",[f.job]),
  'paid audit':async f=>q("insert into shadow_agent.verification_audit values($1,'settled','{}')",[f.job]),
  'receipt':async f=>q("insert into agent_verification.receipts values(gen_random_uuid(),jsonb_build_object('storyKey',$1::text))",[f.story]),
  'inbox history':async f=>q("insert into public.warpcore_curator_inbox(story_key,state) values($1,'processed')",[f.story]),
  'publication history':async f=>q("insert into public.warpcore_publications values($1,'published')",[f.story]),
  'global disabled':async()=>db.exec('update shadow_agent.producer_settings set enabled=false'),
  'verifier disabled':async()=>db.exec('update shadow_agent.verification_settings set enabled=false'),
  'downstream inbox':async()=>db.exec("insert into public.warpcore_curator_inbox(story_key,state) values('unrelated','pending')"),
  'downstream publication':async()=>db.exec("insert into public.warpcore_publications values('unrelated','uncertain')")
 };
 for(const [name,block] of Object.entries(refusals)){
  await db.exec('begin');const f=await fixture(db);await block(f);const before=await ledger();const revision=(await q('select revision from shadow_agent.runs where id=$1',[f.child]))[0].revision;
  assert.equal(await claim(),null,name+' cannot reopen');assert.equal((await q('select revision from shadow_agent.runs where id=$1',[f.child]))[0].revision,revision);assert.deepEqual(await ledger(),before);await db.exec('rollback');
 }
 for(const prior of [1,2]){
  await db.exec('begin');const repeated=await fixture(db);
  await q("insert into shadow_agent.verification_source_retry_audit select $1,n,'source_transport_failure',now()-interval '1 hour',now()-interval '30 minutes',n-1,n,'{}','{}' from generate_series(1,$2::int) n",[repeated.job,prior]);
  assert.equal((await claim()).jobId,repeated.job,'Second and third unpaid refetches remain available after backoff');
  assert.equal((await q('select max(retry_number)::int n from shadow_agent.verification_source_retry_audit where job_id=$1',[repeated.job]))[0].n,prior+1);await db.exec('rollback');
 }
 await db.exec('begin');const duePriority=await fixture(db),ordinary=await fixture(db);
 await q("update shadow_agent.verification_jobs set status='pending' where id=$1",[ordinary.job]);await q("update shadow_agent.runs set state=state||jsonb_build_object('phase','reviewing','activeBatch',jsonb_build_array($2::text)) where id=$1",[ordinary.child,ordinary.story]);
 const auditsBefore=(await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n;assert.equal((await claim()).jobId,ordinary.job,'Existing ordinary pending work keeps its normal priority');assert.equal((await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n,auditsBefore,'Pending work prevents a needless retry reset');await db.exec('rollback');
 await db.exec('begin');const exhausted=await fixture(db);
 await q("insert into shadow_agent.verification_source_retry_audit select $1,n,'source_timeout',now()-interval '1 hour',now()-interval '30 minutes',n,n+1,'{}','{}' from generate_series(1,3) n",[exhausted.job]);
 assert.equal(await claim(),null,'Three unpaid retries exhaust this job');await db.exec('rollback');
 for(const reason of ['source_timeout','source_transport_failure','source_http_failure']){
  await db.exec('begin');const one=await fixture(db,reason),two=await fixture(db,reason);
  const before=(await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n;
  const ready=await claim();assert.ok([one.job,two.job].includes(ready.jobId));assert.equal((await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n,before+1,'Only one due job reopens per normal claim');assert.equal(await claim(),null,'Active pending lease prevents reopening a second due job');await db.exec('rollback');
 }
 await db.exec('begin');const due=await fixture(db);
 await db.exec("insert into public.warpcore_stories values(repeat('d',64),'unverified_review_required',now());insert into public.warpcore_candidates values(repeat('d',64),'rss',now(),'https://example.com/new','Unrelated new story',now(),'fixture:new')");
 const beforeSelect=(await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n;
 assert.equal(await v('select public.warpcore_shadow_select_run() v'),null,'Normal selector yields to a due unpaid recovery before unrelated new discovery');assert.equal((await q('select count(*)::int n from shadow_agent.verification_source_retry_audit'))[0].n,beforeSelect,'Selector availability read never resets or audits work');assert.equal((await claim()).jobId,due.job);await db.exec('rollback');
 for(const role of ['anon','authenticated','service_role']){
  await db.exec('set role '+role);await assert.rejects(q('select * from shadow_agent.verification_source_retry_audit'),/permission/);await assert.rejects(q('select shadow_agent.advance_unpaid_verification_retry()'),/permission/);await db.exec('reset role');
 }
 console.log('PASS safety matrix: all paid statuses, gates, evidence/receipt history, failure taxonomy, backoff, max3, one-at-a-time, selector priority and private grants');
 console.log('PASS initial unpaid retry, fresh revision/lease/activeBatch, old-worker fencing, immutable audit and no paid reservation');
}finally{await db.close();}
