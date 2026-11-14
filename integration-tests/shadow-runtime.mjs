// Offline composition: real embedded PostgreSQL functions + workflow + adapter.
// HTTP is exclusively an injected fake Response. This is not a live model eval.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {newShadowRun} from '../supabase/functions/news-agent/workflow.mjs';
import {runShadowInvocation} from '../supabase/functions/news-agent/runtime.mjs';

const sql = await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql', import.meta.url), 'utf8');
const timestamp = '2026-11-14T20:00:00Z';
const model = 'fixture/offline-model';
const secret = 'offline-fixture-key-not-a-real-credential';
const config = {enabled:true,model,allowedModels:[model],maxOutputTokens:200,
  maxCostCredits:0.2,apiKey:secret,timeoutMs:1000,maxResponseBytes:20000,leaseSeconds:60};
const candidates = ['a','b','c'].map(letter => ({id:letter.repeat(64),
  sourceUrl:`https://example.com/shadow-runtime-${letter}`,sourceType:'rss',sourceCreatedAt:timestamp,
  discoveryText:`Synthetic ${letter} test candidate, not real source evidence.`}));
const decisions = candidates.map(c => ({id:c.id,action:'skip',reason:'Synthetic contract fixture.'}));
const completion = content => ({id:'fixture-generation',model,
  usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0.04},
  choices:[{finish_reason:'stop',message:{content}}]});

async function fixture() {
  const db = new PGlite(), runId = randomUUID(), calls = [];
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(sql);
  await db.query("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,1)");
  await db.query('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,0.5)',
    [runId,newShadowRun({runId,scanStartedAt:timestamp})]);
  await db.exec('set role service_role');
  await assert.rejects(() => db.query('select * from shadow_agent.runs'), /permission denied/);
  const query = async(text,params=[]) => {
    assert.match(text,/^\s*select\s/i,'Runtime must use private SQL function calls');
    assert.match(text,/shadow_agent\.(claim|load|save|reserve|dispatch|settle)\s*\(/i);
    assert.equal(JSON.stringify(params).includes(secret),false,'Never persist the API key');
    assert.equal((await db.query('select current_user as role')).rows[0].role,'service_role');
    calls.push({text,params:structuredClone(params)});
    return db.query(text,params);
  };
  const admin = async(fn) => {await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
  const expire = () => admin(() => db.query("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[runId]));
  const state = async() => (await db.query('select shadow_agent.load($1) as state',[runId])).rows[0].state;
  const ledger = () => admin(async() => ({
    budget:(await db.query('select held_credits::float as held,spent_credits::float as spent from shadow_agent.budgets')).rows[0],
    attempts:(await db.query('select request_hash,status,reserved::float as reserved,actual::float as actual from shadow_agent.attempts')).rows
  }));
  return {db,runId,calls,query,expire,state,ledger};
}

async function scan(f, fetcher) {
  const seen = [];
  const fetchPage = async({cursor,scanStartedAt}) => {
    assert.equal(scanStartedAt,timestamp);
    seen.push(cursor);
    return cursor===null ? candidates.slice(0,2) : cursor===candidates[1].id ? candidates.slice(2) : [];
  };
  for(let i=0;i<3;i++) {
    const result = await runShadowInvocation({runId:f.runId,config,query:f.query,fetcher,fetchPage});
    assert.equal(result.status,'advanced');
    assert.equal(result.publishingEnabled,false);
    assert.equal(result.modelQualityProven,false);
    assert.equal((await f.ledger()).attempts.length,0,'No reservation/model call before terminal empty page');
    if(i<2)assert.equal((await f.state()).phase,'scan');
    await f.expire();
  }
  assert.deepEqual(seen,[null,candidates[1].id,candidates[2].id]);
  assert.equal((await f.state()).phase,'review');
  assert.equal((await f.state()).candidates.length,3);
}

// Disabled configuration cannot even claim a run or fetch candidate data.
let touched = false;
const disabled = await runShadowInvocation({runId:randomUUID(),config:{enabled:false},
  query:async()=>{touched=true;throw Error('query forbidden');},
  fetcher:async()=>{touched=true;throw Error('network forbidden');},
  fetchPage:async()=>{touched=true;throw Error('scan forbidden');}});
assert.equal(disabled.status,'disabled');assert.equal(touched,false);

{
  const f=await fixture();let requests=0,body;
  const fetcher=async(url,options)=>{
    requests++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    body=options.body;
    assert.deepEqual(JSON.parse(JSON.parse(body).messages[1].content).candidates.map(c=>c.id),candidates.map(c=>c.id));
    const before=await f.ledger();
    assert.equal(before.attempts.length,1);assert.equal(before.attempts[0].status,'dispatched');
    assert.equal(before.attempts[0].request_hash,createHash('sha256').update(body).digest('hex'),'Reservation hashes exact HTTP bytes');
    assert.equal(before.budget.held,0.2);
    return Response.json(completion(JSON.stringify({decisions})));
  };
  try {
    await scan(f,fetcher);assert.equal(requests,0);
    const result=await runShadowInvocation({runId:f.runId,config,query:f.query,fetcher,fetchPage:async()=>{throw Error('Scan already complete');}});
    assert.equal(result.status,'advanced');assert.equal(requests,1);
    assert.deepEqual((await f.state()).decisions,decisions);
    assert.equal((await f.state()).phase,'review');
    assert.deepEqual((await f.ledger()).budget,{held:0,spent:0.04});
    assert.equal((await f.ledger()).attempts[0].status,'settled');
    await f.expire();
    const done=await runShadowInvocation({runId:f.runId,config,query:f.query,fetcher,fetchPage:async()=>{throw Error('No more scans');}});
    assert.equal(done.state.phase,'complete');assert.equal(requests,1);
    assert.equal(done.publishingEnabled,false);assert.equal(done.modelQualityProven,false);
  } finally {await f.db.close();}
}

for(const mode of ['malformed-known-cost','unknown-timeout']) {
  const f=await fixture();let requests=0;
  const failureConfig={...config,timeoutMs:mode==='unknown-timeout'?20:1000};
  const fetcher=async()=>{
    requests++;
    if(mode==='unknown-timeout')return new Promise(()=>{});
    return Response.json(completion('{broken decision JSON'));
  };
  try {
    await scan(f,fetcher);assert.equal(requests,0);
    await assert.rejects(()=>runShadowInvocation({runId:f.runId,config:failureConfig,query:f.query,fetcher,fetchPage:async()=>[]}),
      error=>{assert.equal(error.message.includes(secret),false);return true;});
    assert.equal(requests,1);assert.equal((await f.state()).phase,'uncertain');
    const after=await f.ledger();assert.equal(after.attempts.length,1);
    if(mode==='malformed-known-cost') {
      assert.deepEqual(after.budget,{held:0,spent:0.04});assert.equal(after.attempts[0].status,'settled');
    } else {
      assert.deepEqual(after.budget,{held:0.2,spent:0});assert.equal(after.attempts[0].status,'uncertain');
    }
    const busy=await runShadowInvocation({runId:f.runId,config:failureConfig,query:f.query,fetcher,fetchPage:async()=>[]});
    assert.equal(busy.status,'busy');assert.equal(requests,1);
    await f.expire();
    await assert.rejects(()=>runShadowInvocation({runId:f.runId,config:failureConfig,query:f.query,fetcher,fetchPage:async()=>[]}));
    assert.equal(requests,1,'Uncertain checkpoint must not trigger another model attempt');
    assert.equal((await f.ledger()).attempts.length,1);
  } finally {await f.db.close();}
}
console.log('PASS: offline PGlite runtime composition, complete scan before model, exact request reservation, actual/unknown accounting and no retry; no live model or publishing');
