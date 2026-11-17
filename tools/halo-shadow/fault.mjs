// Docker-internal fault campaign after exercise.mjs. Requires the local server's
// test-only settlement interception. Preserves every run, attempt and audit.
import fs from 'node:fs/promises';
import {createHmac,randomUUID} from 'node:crypto';
import pg from '../../integration-tests/node_modules/pg/lib/index.js';
import {POLICY_VERSION} from '../../supabase/functions/news-agent/policy.mjs';
const started=Date.now(),deadline=started+30000,events=[];
const result={campaign:'halo-dropped-settlement-v1',startedAt:new Date(started).toISOString(),publishingEnabled:false,events};
let stage='configuration',client,connected=false,inTransaction=false;
const fail=code=>{const error=new Error(code);error.campaignCode=code;throw error;};
const check=(condition,code)=>{if(!condition)fail(code);};
const remaining=()=>{check(Date.now()<deadline,'fault_campaign_deadline_exceeded');return deadline-Date.now();};
const q=async(sql,args=[])=>(await client.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(){const data=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role:'service_role',exp:Math.floor(Date.now()/1000)+3600});return data+'.'+createHmac('sha256',process.env.JWT_SECRET).update(data).digest('base64url');}
const progress=(type,data={})=>{const event={type,at:new Date().toISOString(),...data};events.push(event);console.log(JSON.stringify(event));};
async function request(){
 const response=await fetch('http://edge:8000',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+jwt(),'Content-Type':'application/json','x-warpcore-agent-token':process.env.WARPCORE_AGENT_PRODUCER_TOKEN},body:'{}',signal:AbortSignal.timeout(Math.min(10000,remaining()))});
 const text=await response.text();check(text.length<20000,'oversized_response');
 let body;try{body=JSON.parse(text);}catch{body=null;}
 return {status:response.status,body};
}
async function history(){return q('select id,state,revision,held_credits::text,spent_credits::text,blocked,lease_token,lease_until from shadow_agent.runs where id<>$1 order by id',[result.runId]);}
async function snapshot(){
 const state=await scalar('select state as value from shadow_agent.runs where id=$1',[result.runId]);
 const attempts=await q('select id,status,reserved::float,actual::float from shadow_agent.attempts where run_id=$1 order by id',[result.runId]);
 const audits=await scalar('select count(*)::integer as value from shadow_agent.attempt_audit x join shadow_agent.attempts a on a.id=x.attempt_id where a.run_id=$1',[result.runId]);
 const decisions=await scalar('select count(*)::integer as value from shadow_agent.decisions where run_id=$1',[result.runId]);
 const held=await scalar('select held_credits::float as value from shadow_agent.runs where id=$1',[result.runId]);
 return {state,attempts,audits,decisions,held};
}
async function artifact(){await fs.mkdir('/artifacts',{recursive:true});await fs.writeFile('/artifacts/fault-result.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});}
try{
 check(process.env.PGHOST==='postgres'&&process.env.PGDATABASE==='warpcore_test'&&process.env.PGUSER==='postgres','dedicated_internal_database_required');
 check(typeof process.env.PGPASSWORD==='string'&&process.env.PGPASSWORD.length>0,'database_password_missing');
 check(typeof process.env.JWT_SECRET==='string'&&process.env.JWT_SECRET.length>=32,'jwt_secret_missing');
 check(typeof process.env.WARPCORE_AGENT_PRODUCER_TOKEN==='string'&&process.env.WARPCORE_AGENT_PRODUCER_TOKEN.length>=32,'producer_token_missing');
 client=new pg.Client({host:'postgres',port:5432,user:'postgres',password:process.env.PGPASSWORD,database:'warpcore_test',connectionTimeoutMillis:5000,statement_timeout:5000});
 client.on('error',()=>{});await client.connect();connected=true;
 stage='precondition';
 check(await scalar("select not exists(select 1 from shadow_agent.runs where state->>'phase' is distinct from 'complete') as value"),'incomplete_run_already_exists');
 check(await scalar("select exists(select 1 from shadow_agent.runs where state->>'phase'='complete' and state->>'candidateCount'='405' and state->>'reviewedCount'='405') as value"),'completed_main_campaign_required');
 check(await scalar('select enabled as value from shadow_agent.producer_settings where singleton'),'producer_not_enabled');
 check(await scalar("select exists(select 1 from shadow_agent.budgets where day=(clock_timestamp() at time zone 'utc')::date and not blocked and limit_credits-spent_credits-held_credits>=0.01) as value"),'existing_synthetic_budget_required');
 const fixture=(await q("select story_key as id,source_url,source_type,source_created_at,left(text,800) as discovery_text from public.warpcore_candidates where fixture_kind='synthetic-nonpublishing-spike-v1' order by story_key limit 1"))[0];
 check(fixture&&/^https:\/\/example\.com\//.test(fixture.source_url),'synthetic_fixture_missing');
 result.runId=randomUUID();
 const baselineHistory=await history();
 const baselineCounts=(await q('select (select count(*)::integer from shadow_agent.attempts) as attempts,(select count(*)::integer from shadow_agent.attempt_audit) as audits,(select count(*)::integer from shadow_agent.decisions) as decisions'))[0];
 const candidate={id:fixture.id,sourceUrl:fixture.source_url,sourceType:fixture.source_type,sourceCreatedAt:fixture.source_created_at.toISOString(),discoveryText:fixture.discovery_text};
 const state={storageKind:'paged-v1',runId:result.runId,scanStartedAt:new Date().toISOString(),policyVersion:POLICY_VERSION,revision:0,phase:'review',cursor:candidate.id,candidateCount:1,reviewedCount:0,activeBatch:null,publishingEnabled:false};
 stage='seed_one_fault_run';
 await client.query('begin');inTransaction=true;
 await client.query('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,0.1)',[result.runId,state]);
 await client.query('insert into shadow_agent.candidates(run_id,ordinal,candidate_id,candidate) values ($1,0,$2,$3)',[result.runId,candidate.id,candidate]);
 await client.query('commit');inTransaction=false;
 progress('fault_run_seeded',{runId:result.runId,candidateCount:1,publishingEnabled:false});
 stage='intercepted_settlement';
 const response=await request();
 check(response.status===502&&response.body?.error==='agent_run_failed'&&response.body.publishing_enabled===false,'expected_intercepted_settlement_failure');
 const failed=await snapshot();
 check(failed.state.phase==='uncertain'&&failed.state.reviewedCount===0&&failed.state.candidateCount===1&&failed.state.publishingEnabled===false,'run_not_held_uncertain');
 check(failed.attempts.length===1&&failed.attempts[0].status==='dispatched'&&failed.attempts[0].reserved===0.01&&failed.attempts[0].actual===null,'incorrect_uncertain_attempt');
 check(failed.held===0.01&&failed.audits===0&&failed.decisions===0,'unknown_settlement_hold_not_preserved');
 result.failureCheckpoint={phase:failed.state.phase,revision:failed.state.revision,reviewedCount:0,candidateCount:1,attemptStatus:'dispatched',reservedCredits:0.01,heldCredits:0.01,actualCredits:null,audits:0,decisions:0};
 progress('uncertain_hold_verified',result.failureCheckpoint);
 stage='no_automatic_replay';
 for(let attempt=0;attempt<3;attempt++){
  // One repeat follows natural expiry as well as repeats while the lease is live.
  if(attempt===1){check(remaining()>11000,'insufficient_time_for_natural_expiry');await new Promise(resolve=>setTimeout(resolve,11000));}
  const repeat=await request();
  check(repeat.status===200&&repeat.body?.mode==='idle'&&repeat.body.publishing_enabled===false,'uncertain_run_was_replayed');
  check(JSON.stringify(await snapshot())===JSON.stringify(failed),'uncertain_state_changed_after_repeat');
  progress('repeat_held_idle',{repeat:attempt+1,naturalExpiryWait:attempt===1});
 }
 stage='preserved_history';
 check(JSON.stringify(await history())===JSON.stringify(baselineHistory),'prior_run_history_changed');
 const counts=(await q(`select (select count(*)::integer from shadow_agent.attempts) as attempts,
 (select count(*)::integer from shadow_agent.attempt_audit) as audits,
 (select count(*)::integer from shadow_agent.decisions) as decisions,
 (select count(*)::integer from public.warpcore_curator_inbox) as inbox,
 (select count(*)::integer from public.warpcore_publications) as publications`))[0];
 check(counts.attempts===baselineCounts.attempts+1&&counts.audits===baselineCounts.audits&&counts.decisions===baselineCounts.decisions,'unexpected_global_ledger_changes');
 check(counts.inbox===0&&counts.publications===0,'publication_boundary_changed');remaining();
 result.status='passed';result.completedAt=new Date().toISOString();result.elapsedMs=Date.now()-started;result.counts=counts;
 result.historyPreserved=true;result.repeatedRequests=3;result.naturalLeaseExpiryOnly=true;result.reconciliationPerformed=false;
 await artifact();progress('fault_campaign_passed',{runId:result.runId,elapsedMs:result.elapsedMs,heldCredits:0.01,publishingEnabled:false});
}catch(error){
 if(inTransaction)await client.query('rollback').catch(()=>{});
 result.status='failed';result.failedAt=new Date().toISOString();result.elapsedMs=Date.now()-started;
 result.failure={stage,code:typeof error?.campaignCode==='string'?error.campaignCode:'operation_failed'};
 try{await artifact();}catch{}
 console.error(JSON.stringify({type:'fault_campaign_failed',...result.failure}));process.exitCode=1;
}finally{if(connected)await client.end().catch(()=>{});}
