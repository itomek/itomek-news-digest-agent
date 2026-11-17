// Disposable setup/inspection only. No provider HTTP or paid dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import pg from '../../integration-tests/node_modules/pg/lib/index.js';
import {newPagedShadowRun} from '../../supabase/functions/news-agent/paged-runtime.mjs';
import {buildReviewRequest} from '../../supabase/functions/news-agent/evaluation.mjs';
import {serializeReviewBody} from '../../supabase/functions/news-agent/openrouter.mjs';
import {requestProfileForModel,expectedProviderForModel} from '../../supabase/functions/news-agent/model-profiles.mjs';
const root=new URL('../../',import.meta.url);
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function buildSmokePlan({runId,model,reservationUsd,cases}){
 const profile=requestProfileForModel(model),expectedProvider=expectedProviderForModel(model);
 if(!uuid.test(runId??'')||profile?.provider.zdr!==true||!expectedProvider||!Number.isFinite(reservationUsd)||reservationUsd<=0||reservationUsd>2||!Array.isArray(cases)||cases.length!==8)throw Error('Invalid smoke configuration');
 const candidates=cases.slice(0,4).map((c,i)=>({id:createHash('sha256').update('canary-case-'+i).digest('hex'),sourceUrl:c.sourceUrl,sourceType:c.sourceType,sourceCreatedAt:c.sourceCreatedAt,discoveryText:c.discoveryText})).sort((a,b)=>a.id.localeCompare(b.id));
 const request=buildReviewRequest(candidates,{model,allowedModels:[model],maxOutputTokens:2048,requestProfile:profile});
 const body=serializeReviewBody(request),requestHash=createHash('sha256').update(body).digest('hex');
 return {kind:'one-shot-sql-backed-public-development-smoke-v1',runId,model,expectedProvider,reservationUsd,maxOutputTokens:2048,reviewBatchSize:4,timeoutMs:30000,leaseSeconds:120,requestHash,requestBytes:Buffer.byteLength(body),candidates,requestBody:body,publishingEnabled:false,modelQualityProven:false};
}
async function privateDirectory(dir){
 if(!path.isAbsolute(dir))throw Error('Private absolute plan directory required');
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const real=await fs.realpath(dir),repo=await fs.realpath(fileURLToPath(root));
 if(real===repo||real.startsWith(repo+path.sep)||(await fs.stat(real)).mode&0o077)throw Error('Private plan directory must be outside checkout');
 return real;
}
async function main(){
 const mode=process.argv[2];if(!['prepare','inspect'].includes(mode)||process.argv.length!==3)throw Error('Use prepare or inspect');
 const env=process.env;
 if(env.PGHOST!=='postgres'||env.PGUSER!=='postgres'||env.PGDATABASE!=='warpcore_test'||!env.PGPASSWORD)throw Error('Dedicated internal database required');
 const dir=await privateDirectory(env.HALO_PAID_PLAN_DIR??'/artifacts/paid-smoke');
 const client=new pg.Client({host:'postgres',port:5432,user:'postgres',database:'warpcore_test',password:env.PGPASSWORD,connectionTimeoutMillis:10000,statement_timeout:10000});
 client.on('error',()=>{});await client.connect();
 const q=async(sql,args=[])=>(await client.query(sql,args)).rows;
 const value=async(sql,args=[])=>(await q(sql,args))[0].value;
 try{
  if(mode==='prepare'){
   if(typeof env.JWT_SECRET!=='string'||env.JWT_SECRET.length<32)throw Error('Disposable JWT signing secret required');
   const cases=JSON.parse(await fs.readFile(new URL('supabase/functions/news-agent/real-story-cases.json',root),'utf8'));
   const plan=buildSmokePlan({runId:randomUUID(),model:env.HALO_PAID_MODEL??'google/gemma-4-31b-it',reservationUsd:Number(env.HALO_PAID_RESERVATION_USD??'0.058983'),cases});
   // Refuse overwrite BEFORE installing or changing any database object.
   for(const file of ['plan.json','plan.env']){try{await fs.lstat(path.join(dir,file));throw Error('Plan already exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
   if(!await value("select to_regnamespace('shadow_agent') is null and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and left(c.relname,9)='warpcore_') as value"))throw Error('Fresh disposable database required');
   for(const file of ['supabase/functions/news-agent-spike/fixture.sql',...['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-producer.sql'].map(n=>'supabase/functions/news-agent/sql/'+n)])await client.query(await fs.readFile(new URL(file,root),'utf8'));
   await client.query('begin');
   try{
    await q("insert into shadow_agent.budgets(day,limit_credits) values ((clock_timestamp() at time zone 'utc')::date,$1)",[plan.reservationUsd]);
    await q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,$3)',[plan.runId,newPagedShadowRun({runId:plan.runId,scanStartedAt:new Date().toISOString()}),plan.reservationUsd]);
    const lease=await value('select shadow_agent.claim($1,1) as value',[plan.runId]);
    await value('select shadow_agent.paged_append($1,$2,0,$3) as value',[plan.runId,lease,plan.candidates]);
    await value('select shadow_agent.paged_append($1,$2,1,$3) as value',[plan.runId,lease,[]]);
    await client.query('commit');
   }catch(error){await client.query('rollback');throw error;}
   const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
   const unsigned=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'service_role',exp:Math.floor(Date.now()/1000)+3600});
   const serviceJWT=unsigned+'.'+createHmac('sha256',env.JWT_SECRET).update(unsigned).digest('base64url');
   await fs.writeFile(path.join(dir,'plan.json'),JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
   const fields={HALO_PAID_RUN_ID:plan.runId,HALO_PAID_MODEL:plan.model,HALO_PAID_REQUEST_HASH:plan.requestHash,HALO_PAID_RESERVATION_USD:String(plan.reservationUsd),HALO_PAID_SERVICE_JWT:serviceJWT};
   await fs.writeFile(path.join(dir,'plan.env'),Object.entries(fields).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600,flag:'wx'});
   await client.query("notify pgrst,'reload schema'");
   console.log(JSON.stringify({status:'prepared_no_dispatch',runId:plan.runId,model:plan.model,requestHash:plan.requestHash,requestBytes:plan.requestBytes,reservationUsd:plan.reservationUsd,candidates:4,producerEnabled:false}));
  }else{
   const plan=JSON.parse(await fs.readFile(path.join(dir,'plan.json'),'utf8'));
   if(!uuid.test(plan.runId??''))throw Error('Invalid inspection run');
   const state=await value('select state as value from shadow_agent.runs where id=$1',[plan.runId]);
   const attempts=await q('select id,request_hash,status,reserved::text,actual::text,checkpoint_revision from shadow_agent.attempts where run_id=$1 order by id',[plan.runId]);
   const audits=await q('select a.id as attempt_id,x.status,x.audit from shadow_agent.attempts a join shadow_agent.attempt_audit x on x.attempt_id=a.id where a.run_id=$1 order by a.id,x.status',[plan.runId]);
   const decisions=await q('select ordinal,decision from shadow_agent.decisions where run_id=$1 order by ordinal',[plan.runId]);
   const boundary=(await q('select (select count(*)::int from public.warpcore_curator_inbox) as inbox,(select count(*)::int from public.warpcore_publications) as publications,(select sum(held_credits)::text from shadow_agent.budgets) as held_credits,(select sum(spent_credits)::text from shadow_agent.budgets) as spent_credits,(select enabled from shadow_agent.producer_settings where singleton) as producer_enabled'))[0];
   const matched=attempts.length===1&&attempts[0].request_hash===plan.requestHash;
   const settled=matched&&attempts[0].status==='settled'&&attempts[0].actual!==null&&audits.some(a=>a.attempt_id===attempts[0].id&&a.status==='settled'&&a.audit?.usage?.costCredits!==undefined&&String(a.audit.usage.costCredits)===String(Number(attempts[0].actual)));
   const result={kind:'sql-backed-paid-smoke-inspection',at:new Date().toISOString(),runId:plan.runId,model:plan.model,requestHash:plan.requestHash,state,attempts,audits,decisions,boundary,requestHashMatches:matched,billingSettled:settled,publishingEnabled:false,modelQualityProven:false};
   await fs.writeFile(path.join(dir,'inspection-'+Date.now()+'.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
   const passed=settled&&decisions.length===4&&state.reviewedCount===4&&['review','complete'].includes(state.phase)&&Number(boundary.held_credits)===0&&boundary.inbox===0&&boundary.publications===0&&boundary.producer_enabled===false;
   console.log(JSON.stringify({status:passed?'smoke_passed':'smoke_incomplete_or_held',runId:plan.runId,attempts:attempts.length,decisions:decisions.length,billingSettled:settled,requestHashMatches:matched,heldCredits:boundary.held_credits,publishingEnabled:false}));
   if(!passed)process.exitCode=2;
  }
 }finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error(JSON.stringify({status:'smoke_setup_or_inspection_failed'}));process.exitCode=1;});
