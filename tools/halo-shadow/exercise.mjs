// Disposable Docker-internal campaign only. No cloud URL, provider, source HTTP,
// production credentials, lease rewrites or container lifecycle operations.
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import pg from '../../integration-tests/node_modules/pg/lib/index.js';
import {POLICY_VERSION} from '../../supabase/functions/news-agent/policy.mjs';
const START=Date.now(),MAX_DURATION=8*60*1000;
const ENDPOINT='http://edge:8000';
const interval=Number(process.env.HALO_TEST_INTERVAL_MS??11000);
const events=[];
let stage='configuration',client,connected=false;
const result={campaign:'halo-natural-lease-shadow-v1',startedAt:new Date(START).toISOString(),publishingEnabled:false,modelCalls:'fabricated-in-process',events};
const fail=code=>{const error=new Error(code);error.campaignCode=code;throw error;};
const check=(condition,code)=>{if(!condition)fail(code);};
const progress=(type,data={})=>{const event={type,at:new Date().toISOString(),...data};events.push(event);console.log(JSON.stringify(event));};
const remaining=()=>{check(Date.now()-START<MAX_DURATION,'campaign_deadline_exceeded');return MAX_DURATION-(Date.now()-START);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.min(ms,remaining())));
const q=async(text,values=[])=>(await client.query(text,values)).rows;
const scalar=async(text,values=[])=>(await q(text,values))[0].value;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt=(claims={},secret=process.env.JWT_SECRET)=>{
 const data=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role:'service_role',exp:Math.floor(Date.now()/1000)+3600,...claims});
 return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
};
async function request({token=jwt(),producer=process.env.WARPCORE_AGENT_PRODUCER_TOKEN,method='POST',body='{}',timeoutMs=15000}={}){
 remaining();
 const headers={'Content-Type':'application/json'};
 if(token!==null)headers.Authorization='Bearer '+token;
 if(producer!==null)headers['x-warpcore-agent-token']=producer;
 const response=await fetch(ENDPOINT,{method,headers,...(method==='GET'?{}:{body}),redirect:'error',signal:AbortSignal.timeout(Math.min(timeoutMs,remaining()))});
 const text=await response.text();check(text.length<20000,'oversized_edge_response');
 let data;try{data=JSON.parse(text);}catch{data=null;}
 return {status:response.status,data};
}
async function checkpoint(){
 const rows=await q('select id,state,extract(epoch from (lease_until-clock_timestamp()))::float as remaining_seconds from shadow_agent.runs order by id');
 check(rows.length<=1,'unexpected_multiple_runs');
 return rows[0]??null;
}
function recordAdvance(before,after,reply){
 check(reply.status===200&&reply.data?.status==='advanced','advance_response_expected');
 check(reply.data.publishing_enabled===false,'publication_flag_changed');
 check(after&&after.state.revision>(before?.state.revision??0),'revision_did_not_advance');
 const s=after.state;
 check(s.publishingEnabled===false,'checkpoint_publication_flag_changed');
 check(Number.isSafeInteger(s.candidateCount)&&Number.isSafeInteger(s.reviewedCount)&&s.reviewedCount<=s.candidateCount,'invalid_coverage');
 if((before?.state.phase??'scan')==='scan'){
  const size=s.candidateCount-(before?.state.candidateCount??0);
  check(size>=0&&size<=100,'invalid_scan_page_increment');
  result.scanPageSizes.push(size);
 }
 result.advances++;
 progress('advanced',{step:result.advances,runId:after.id,revision:s.revision,phase:s.phase,candidateCount:s.candidateCount,reviewedCount:s.reviewedCount});
}
async function writeResult(){
 await fs.mkdir('/artifacts',{recursive:true});
 await fs.writeFile('/artifacts/result.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
}
try{
 check(process.env.PGHOST==='postgres'&&process.env.PGDATABASE==='warpcore_test'&&process.env.PGUSER==='postgres','dedicated_internal_database_required');
 check(typeof process.env.PGPASSWORD==='string'&&process.env.PGPASSWORD.length>0,'database_password_missing');
 check(typeof process.env.JWT_SECRET==='string'&&process.env.JWT_SECRET.length>=32,'jwt_secret_missing');
 check(typeof process.env.WARPCORE_AGENT_PRODUCER_TOKEN==='string'&&process.env.WARPCORE_AGENT_PRODUCER_TOKEN.length>=32,'producer_token_missing');
 check(Number.isSafeInteger(interval)&&interval>=11000&&interval<=15000,'natural_lease_interval_required');
 client=new pg.Client({host:'postgres',port:5432,user:'postgres',password:process.env.PGPASSWORD,database:'warpcore_test',connectionTimeoutMillis:10000,statement_timeout:10000});
 client.on('error',()=>{}); // Pending operations reject through the sanitized catch below.
 await client.connect();connected=true;
 stage='fresh_database_guard';
 check(await scalar("select not exists(select 1 from pg_namespace where nspname='shadow_agent') and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and left(c.relname,9)='warpcore_') as value"),'database_not_fresh');
 for(const role of ['anon','authenticated','service_role']){
  if(!await scalar('select exists(select 1 from pg_roles where rolname=$1) as value',[role]))await client.query(`create role ${role}`);
 }
 stage='install_disposable_fixture';
 const root=new URL('../../',import.meta.url);
 for(const path of ['supabase/functions/news-agent-spike/fixture.sql',...['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-producer.sql'].map(name=>'supabase/functions/news-agent/sql/'+name)])await client.query(await fs.readFile(new URL(path,root),'utf8'));
 await client.query("notify pgrst, 'reload schema'");
 progress('fixture_installed',{syntheticStories:405,producerEnabled:false});
 stage='edge_http_readiness';
 let httpReady=false;
 const httpDeadline=Date.now()+30000;
 while(Date.now()<httpDeadline){
  try{const reply=await request({token:null,timeoutMs:Math.min(3000,Math.max(1,httpDeadline-Date.now()))});if(reply.status===401){httpReady=true;break;}}catch{}
  await sleep(500);
 }
 check(httpReady,'edge_http_not_ready');
 stage='edge_database_bridge_readiness';
 // Valid authentication with a disabled selector is a harmless full bridge probe.
 let ready=false;
 const bridgeDeadline=Date.now()+30000;
 while(Date.now()<bridgeDeadline){
  try{const reply=await request({timeoutMs:Math.min(3000,Math.max(1,bridgeDeadline-Date.now()))});if(reply.status===200&&reply.data?.mode==='idle'){ready=true;break;}}catch{}
  await sleep(1000);
 }
 check(ready,'edge_bridge_not_ready');
 stage='test_only_admin_activation';
 await client.query("insert into shadow_agent.budgets(day,limit_credits) values ((clock_timestamp() at time zone 'utc')::date,1)");
 await client.query('update shadow_agent.producer_settings set enabled=true,run_limit_credits=1,policy_version=$1',[POLICY_VERSION]);
 stage='negative_authorization';
 const negatives=[
  ['missing_authorization',{token:null},401],
  ['malformed_authorization',{token:'not-a-jwt'},401],
  ['wrong_signature',{token:jwt({},'fabricated-wrong-signing-secret-never-valid')},401],
  ['expired_authorization',{token:jwt({exp:Math.floor(Date.now()/1000)-1})},401],
  ['wrong_role',{token:jwt({role:'authenticated'})},401],
  ['wrong_producer_token',{producer:'fabricated-wrong-producer-token'},401],
  ['missing_producer_token',{producer:null},401],
  ['wrong_method',{method:'GET'},405],
  ['body_authority_override',{body:JSON.stringify({model:'paid/model',runId:'not-allowed'})},400],
  ['oversized_body',{body:' '.repeat(257)},400],
 ];
 for(const [name,options,expected]of negatives){const reply=await request(options);check(reply.status===expected,'negative_case_failed_'+name);check(await scalar('select count(*)::integer=0 as value from shadow_agent.runs'),'negative_case_created_run');progress('authorization_rejected',{case:name,status:reply.status});}
 stage='overlapping_first_trigger';
 result.scanPageSizes=[];result.advances=0;
 const burst=await Promise.all(Array.from({length:5},()=>request()));
 check(burst.every(reply=>reply.status===200&&reply.data?.publishing_enabled===false),'burst_request_failed');
 const advanced=burst.filter(reply=>reply.data?.status==='advanced');
 check(advanced.length===1,'overlapping_trigger_advanced_more_than_once');
 check(burst.every(reply=>reply.data.mode==='idle'||['advanced','busy'].includes(reply.data.status)),'unexpected_burst_outcome');
 let current=await checkpoint();
 check(current&&current.remaining_seconds>=9&&current.remaining_seconds<=11,'expected_ten_second_natural_lease');
 result.observedInitialLeaseRemainingSeconds=current.remaining_seconds;
 recordAdvance(null,current,advanced[0]);
 progress('overlap_checked',{requests:burst.length,advanced:advanced.length});
 const beforeIdle=current.state.revision;
 const idle=await request();
 check(idle.status===200&&(idle.data.mode==='idle'||idle.data.status==='busy'),'live_lease_did_not_block_overlap');
 check((await checkpoint()).state.revision===beforeIdle,'idle_trigger_mutated_checkpoint');
 stage='natural_lease_campaign';
 while(current.state.phase!=='complete'){
  await sleep(interval);
  const reply=await request();
  const next=await checkpoint();
  recordAdvance(current,next,reply);current=next;
 }
 stage='final_database_assertions';
 const counts=(await q(`select
  (select count(*)::integer from shadow_agent.runs) as runs,
  (select count(*)::integer from shadow_agent.producer_slots) as slots,
  (select count(*)::integer from shadow_agent.candidates) as candidates,
  (select count(*)::integer from shadow_agent.decisions) as decisions,
  (select count(distinct decision->>'id')::integer from shadow_agent.decisions) as unique_decisions,
  (select count(*)::integer from shadow_agent.attempts) as attempts,
  (select count(*)::integer from shadow_agent.attempt_audit) as audits,
  (select count(*)::integer from shadow_agent.attempts where status='settled' and actual=0 and reserved=0.01) as settled_zero_cost_attempts,
  (select count(*)::integer from shadow_agent.attempt_audit where status='settled' and audit->>'model'='fixture/hosted-spike' and (audit->'usage'->>'costCredits')::numeric=0) as zero_cost_audits,
  (select count(*)::integer from public.warpcore_curator_inbox) as inbox,
  (select count(*)::integer from public.warpcore_publications) as publications,
  (select count(*)::integer from shadow_agent.decisions d join shadow_agent.candidates c using(run_id,ordinal) where d.decision->>'id'=c.candidate_id) as exact_candidate_decisions,
  (select coalesce(sum(held_credits),0)::float from shadow_agent.budgets) as held_credits,
  (select coalesce(sum(spent_credits),0)::float from shadow_agent.budgets) as spent_credits`))[0];
 check(counts.runs===1&&counts.slots===1,'unexpected_run_or_slot_count');
 check(counts.candidates===405&&counts.decisions===405&&counts.unique_decisions===405&&counts.exact_candidate_decisions===405,'incomplete_candidate_coverage');
 check(counts.attempts===17&&counts.audits===17&&counts.settled_zero_cost_attempts===17&&counts.zero_cost_audits===17,'incorrect_attempt_or_audit_count');
 check(counts.inbox===0&&counts.publications===0&&counts.held_credits===0&&counts.spent_credits===0,'publication_or_cost_boundary_changed');
 const lastId=await scalar('select decision->>\'id\' as value from shadow_agent.decisions order by ordinal desc limit 1');
 check(lastId===(405).toString(16).padStart(64,'0'),'last_page_candidate_not_reviewed');
 check(JSON.stringify(result.scanPageSizes)===JSON.stringify([100,100,100,100,5,0]),'incorrect_page_sequence');
 check(result.advances===24&&current.state.reviewedCount===405&&current.state.candidateCount===405,'incorrect_advance_count');
 remaining();
 result.status='passed';result.completedAt=new Date().toISOString();result.elapsedMs=Date.now()-START;
 result.intervalMs=interval;result.naturalLeaseExpiryOnly=true;result.counts=counts;result.lastReviewedId=lastId;
 result.finalCheckpoint={runId:current.id,revision:current.state.revision,phase:current.state.phase,candidateCount:405,reviewedCount:405};
 await writeResult();progress('campaign_passed',{advances:result.advances,elapsedMs:result.elapsedMs,candidates:405,decisions:405,attempts:17,publishingEnabled:false});
}catch(error){
 // Never serialize raw database/fetch errors: they can contain SQL parameters.
 result.status='failed';result.failedAt=new Date().toISOString();result.elapsedMs=Date.now()-START;
 result.failure={stage,code:typeof error?.campaignCode==='string'?error.campaignCode:'operation_failed'};
 try{await writeResult();}catch{}
 console.error(JSON.stringify({type:'campaign_failed',...result.failure}));process.exitCode=1;
}finally{if(connected)await client.end().catch(()=>{});}
