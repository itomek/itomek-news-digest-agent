// Disposable SQL + fabricated OpenRouter HTTP only. No hosted or model-quality claim.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {newPagedShadowRun,runPagedShadowInvocation} from '../supabase/functions/news-agent/paged-runtime.mjs';
const db=new PGlite(), stamp='2026-11-14T20:00:00Z', model='fixture/paged-model';
const secret='synthetic-not-a-credential';
const cfg={enabled:true,model,allowedModels:[model],maxOutputTokens:2000,maxCostCredits:0.2,apiKey:secret,timeoutMs:1000,leaseSeconds:60};
const key=n=>n.toString(16).padStart(64,'0');
const all=Array.from({length:405},(_,i)=>({id:key(i+1),sourceUrl:`https://example.com/${i+1}`,sourceType:'rss',sourceCreatedAt:stamp,discoveryText:`Synthetic candidate ${i+1}: `+'x'.repeat(6000)}));
const value=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
let requests=0,reviewed=[];
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const file of ['shadow-state.sql','shadow-paged.sql','shadow-audit.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
 await db.query("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,100)");
 const admin=async(fn)=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
 const seed=async()=>{const runId=randomUUID();await admin(()=>db.query('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,50)',[runId,newPagedShadowRun({runId,scanStartedAt:stamp})]));return runId;};
 const expire=runId=>admin(()=>db.query("update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[runId]));
 const query=async(sql,args)=>{assert.equal(JSON.stringify(args).includes(secret),false);return db.query(sql,args);};
 const fetcher=async(url,options)=>{
  requests++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  const input=JSON.parse(JSON.parse(options.body).messages[1].content).candidates;
  const hash=createHash('sha256').update(options.body).digest('hex');
  const attempt=await admin(()=>db.query('select status from shadow_agent.attempts where request_hash=$1',[hash]));
  assert.equal(attempt.rows[0].status,'dispatched');
  reviewed.push(...input.map(c=>c.id));
  return Response.json({id:`fixture-${requests}`,model,usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:0.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:input.map(c=>({id:c.id,action:c.id===key(405)?'verify':'skip',reason:'Synthetic coverage fixture.'}))})}}]});
 };
 const runId=await seed();
 assert.ok(Buffer.byteLength(JSON.stringify(all))>2000000);
 let scans=0;
 const fetchPage=async({cursor,scanStartedAt})=>{assert.equal(scanStartedAt,stamp);scans++;return all.filter(c=>cursor===null||c.id>cursor).slice(0,100);};
 for(let i=0;i<6;i++){
  const out=await runPagedShadowInvocation({runId,config:cfg,query,fetcher,fetchPage});
  assert.equal(out.status,'advanced');assert.equal(requests,0,'Terminal empty page precedes review');
  assert.ok(Buffer.byteLength(JSON.stringify(out.state))<20000,'Compact checkpoint never hydrates backlog');
  assert.equal(out.state.candidateCount,Math.min((i+1)*100,405));
  await expire(runId);
 }
 assert.equal(scans,6);
 let completed=false;
 for(let i=0;i<100;i++){
  const out=await runPagedShadowInvocation({runId,config:cfg,query,fetcher,fetchPage:async()=>{throw Error('scan finished');}},{reviewBatchSize:100});
  assert.equal(out.status,'advanced');assert.ok(out.state.reviewedCount<=405);
  assert.ok(!Object.hasOwn(out.state,'candidates'));assert.ok(!Object.hasOwn(out.state,'decisions'));
  await expire(runId);
  if(out.state.phase==='complete'){assert.equal(out.state.reviewedCount,405);completed=true;break;}
 }
 assert.equal(completed,true);assert.ok(requests>5,'Exact-byte bounds split requested 100-item batches');assert.deepEqual(reviewed,all.map(c=>c.id));
 const completedRequests=requests;
 const ledger=await admin(()=>db.query('select count(*)::int as n,sum(actual)::float as cost from shadow_agent.attempts where run_id=$1',[runId]));
 assert.equal(ledger.rows[0].n,requests);assert.equal(ledger.rows[0].cost,requests/100);
 // Empty run completes without paid filler or an attempt.
 const empty=await seed();
 await runPagedShadowInvocation({runId:empty,config:cfg,query,fetcher,fetchPage:async()=>[]});await expire(empty);
 const done=await runPagedShadowInvocation({runId:empty,config:cfg,query,fetcher,fetchPage:async()=>[]});
 assert.equal(done.state.phase,'complete');assert.equal(requests,completedRequests);
 // Unknown outcome survives worker restart and never automatically replays.
 const uncertain=await seed();
 for(const page of [[all[0]],[]]){await runPagedShadowInvocation({runId:uncertain,config:cfg,query,fetcher,fetchPage:async()=>page});await expire(uncertain);}
 let attempts=0;
 const failing=async()=>{attempts++;throw Error(secret);};
 await assert.rejects(()=>runPagedShadowInvocation({runId:uncertain,config:cfg,query,fetcher:failing,fetchPage:async()=>[]}),e=>!e.message.includes(secret));
 assert.equal((await value('select shadow_agent.load($1) as value',[uncertain])).phase,'uncertain');await expire(uncertain);
 await assert.rejects(()=>runPagedShadowInvocation({runId:uncertain,config:cfg,query,fetcher:failing,fetchPage:async()=>[]}));assert.equal(attempts,1);
 console.log('PASS: normalized SQL/runtime reviews all 405 same-source candidates beyond 2MB, terminal page, restarts, exact request hashes, final-page decision, accounting, empty scan and uncertain no-replay');
}finally{await db.close();}
