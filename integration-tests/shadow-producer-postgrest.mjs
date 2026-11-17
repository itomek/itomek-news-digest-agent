// Disposable loopback PostgREST + fabricated model response. Never hosted/live.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {Client} from 'pg';import {createHmac,randomUUID} from 'node:crypto';
import {createAgentService} from '../supabase/functions/news-agent/services.mjs';
import {newPagedShadowRun} from '../supabase/functions/news-agent/paged-runtime.mjs';
import {handleAgent} from '../supabase/functions/news-agent/handler.mjs';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||url.pathname!=='/warpcore_test'||url.search||url.hash)throw Error('Dedicated disposable loopback database required');
const jwtSecret=process.env.WARPCORE_TEST_JWT_SECRET;if(!jwtSecret||jwtSecret.length<32)throw Error('Disposable signing key required');
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const jwt=role=>{const p=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+300});return p+'.'+createHmac('sha256',jwtSecret).update(p).digest('base64url');};
const serviceKey=jwt('service_role'),producerToken='synthetic-producer-token-'.repeat(3),model='fixture/postgrest-agent';
const db=new Client({connectionString:url.href}),base='http://127.0.0.1:3000';let installed=false,modelCalls=0,markerSeen=false;
try{
 await db.connect();
 assert.equal((await db.query("select to_regnamespace('shadow_agent') as n")).rows[0].n,null,'Fresh fixture required; never reuse an active shadow schema');
 for(const name of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql','shadow-ranking.sql','shadow-producer.sql']){
  await db.query(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${name}`,import.meta.url),'utf8'));installed=true;
 }
 await db.query("notify pgrst,'reload schema'");
 let ready=false;
 for(let i=0;i<40;i++){
  const r=await fetch(base+'/rpc/warpcore_shadow_select_run',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'},body:'{}'});
  if(r.ok){assert.equal(await r.json(),null);ready=true;break;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert.equal(ready,true,'PostgREST schema must expose only the narrow bridge');
 for(const role of [null,'anon','authenticated']){
  const r=await fetch(base+'/rpc/warpcore_shadow_select_run',{method:'POST',headers:{...(role?{Authorization:`Bearer ${jwt(role)}`}:{ }),'Content-Type':'application/json'},body:'{}'});
  assert.ok([401,403,404].includes(r.status));
 }
 const marker='Synthetic shadow producer PostgREST marker';
 const story=randomUUID().replaceAll('-','').padEnd(64,'0');
 await db.query('select public.warpcore_ingest($1::jsonb)',[JSON.stringify([{uri:'fixture:shadow-producer:'+story,story_key:story,source_type:'rss',source_id:'fixture',actor:'fixture',text:marker,source_created_at:new Date().toISOString(),source_url:'https://example.com/shadow-producer',source_links:['https://example.com/shadow-producer']}])]);
 // Future-by-one-second cutoff avoids fixture client/server submillisecond skew.
 const runId=randomUUID(),stamp=new Date(Date.now()+1000).toISOString();
 await db.query("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,100)");
 await db.query('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,10)',[runId,newPagedShadowRun({runId,scanStartedAt:stamp})]);
 const publicationCount=async()=>(await db.query('select count(*)::int as n from public.warpcore_publications')).rows[0].n;
 const before=await publicationCount();
 const transport=async(destination,options)=>{
  const target=new URL(destination);
  if(target.origin==='https://openrouter.ai'){
   modelCalls++;assert.equal(target.pathname,'/api/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer synthetic-model-key');
   const candidates=JSON.parse(JSON.parse(options.body).messages[1].content).candidates;
   markerSeen ||= candidates.some(c=>c.discoveryText===marker);
   return Response.json({id:`fixture-${modelCalls}`,model,usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:candidates.map(c=>({id:c.id,action:'skip',reason:'Synthetic PostgREST contract.'}))})}}]});
  }
  assert.equal(target.origin,'https://fixture.supabase.co');assert.equal(options.headers.Authorization,`Bearer ${serviceKey}`);
  return fetch(base+target.pathname.replace(/^\/rest\/v1/,'')+target.search,options);
 };
 const service=createAgentService({projectUrl:'https://fixture.supabase.co',serviceKey,runtimeConfig:{enabled:true,model,allowedModels:[model],maxOutputTokens:2000,maxCostCredits:0.2,apiKey:'synthetic-model-key'}},transport);
 const handlerService={selectRun:async()=>runId,runInvocation:service.runInvocation};
 const request=()=>new Request('https://fixture.invalid/news-agent',{method:'POST',headers:{'x-warpcore-agent-token':producerToken},body:'{}'});
 const denied=await handleAgent(new Request('https://fixture.invalid/news-agent',{method:'POST'}),{enabled:true,producerToken},handlerService);assert.equal(denied.status,401);assert.equal(modelCalls,0);
 let complete=false;
 for(let i=0;i<30;i++){
  const response=await handleAgent(request(),{enabled:true,producerToken},handlerService);
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.publishing_enabled,false);
  const state=(await db.query('select state from shadow_agent.runs where id=$1',[runId])).rows[0].state;
  if(state.phase==='complete'){assert.equal(state.reviewedCount,state.candidateCount);complete=true;break;}
  await db.query("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[runId]);
 }
 assert.equal(complete,true);assert.equal(markerSeen,true);assert.ok(modelCalls>0);assert.equal(await publicationCount(),before);
 const audited=(await db.query('select count(*)::int as n from shadow_agent.attempt_audit')).rows[0].n;assert.equal(audited,modelCalls);
 const selection=await fetch(base+'/rpc/warpcore_shadow_selection',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify({p_run:runId})});
 assert.equal(selection.status,200);assert.equal(await selection.json(),null,'Historical unranked run has no ranking authority');
 for(const role of ['anon','authenticated']){
  const denied=await fetch(base+'/rpc/warpcore_shadow_selection',{method:'POST',headers:{Authorization:`Bearer ${jwt(role)}`,'Content-Type':'application/json'},body:JSON.stringify({p_run:runId})});
  assert.ok([401,403,404].includes(denied.status));
 }
 const table=await fetch(base+'/runs',{headers:{Authorization:`Bearer ${serviceKey}`}});assert.ok([401,403,404].includes(table.status));
 console.log('PASS: actual PostgREST producer RPCs, dedicated handler auth, normalized continuation/audit, denied roles and zero publication writes; model responses fabricated');
}finally{
 if(installed){
  // Clean only this script-owned schema/wrappers in the dedicated disposable DB.
  const wrappers=(await db.query("select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'warpcore_shadow_%'")).rows;
  for(const row of wrappers)await db.query(`drop function ${row.signature}`);
  await db.query('drop schema shadow_agent cascade');
 }
 await db.end();
}
