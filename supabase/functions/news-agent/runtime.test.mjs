import test from 'node:test';
import assert from 'node:assert/strict';
import {runShadowInvocation} from './runtime.mjs';
import {newShadowRun} from './workflow.mjs';
const runId='00000000-0000-4000-8000-000000000001';
const config={enabled:true,model:'test/model',allowedModels:['test/model'],maxOutputTokens:100,maxCostCredits:0.1,apiKey:'test-only',timeoutMs:100};
const candidate={id:'a'.repeat(64),sourceUrl:'https://example.com/release',discoveryText:'New release'};
function fixture({dispatch=true,badDecision=false,unknownCost=false}={}){
 let state={...newShadowRun({runId,scanStartedAt:'2026-11-14T20:00:00Z'}),phase:'review',candidates:[candidate],cursor:candidate.id};
 const events=[];let hash;
 return {events,get state(){return state;},query:async(sql,args)=>{
  const op=sql.match(/shadow_agent\.(\w+)/)[1];events.push(op);
  let value;
  if(op==='claim')value='lease';
  if(op==='load')value=state;
  if(op==='save'){assert.equal(args[2],state.revision);state=structuredClone(args[3]);value=true;}
  if(op==='reserve'){hash=args[2];value='attempt';}
  if(op==='dispatch')value=dispatch;
  if(op==='settle'){events.push(args[2]);value=true;}
  return {rows:[{value}]};
 },fetcher:async(_url,{body})=>{
  events.push('http');assert.equal(hash,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('hex'));
  if(unknownCost)throw Error('private transport failure');
  return Response.json({id:'generation',model:'test/model',usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:0.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:badDecision?[]:[{id:candidate.id,action:'verify',reason:'New capability'}]})}}]});
 }};
}
test('default disabled performs no SQL or HTTP',async()=>{
 const result=await runShadowInvocation({query:()=>{throw Error('SQL forbidden')},fetcher:()=>{throw Error('HTTP forbidden')}});
 assert.deepEqual(result,{status:'disabled',publishingEnabled:false,modelQualityProven:false});
});
test('reserves exact body then dispatches once, settles known cost before result checkpoint',async()=>{
 const f=fixture();const result=await runShadowInvocation({runId,config,...f});
 assert.equal(result.state.decisions.length,1);assert.equal(result.modelQualityProven,false);
 assert.deepEqual(f.events,['claim','load','save','reserve','dispatch','http','settle','settled','save']);
});
test('uncertain dispatch prevents HTTP and checkpoints uncertainty',async()=>{
 const f=fixture({dispatch:false});await assert.rejects(runShadowInvocation({runId,config,...f}));
 assert.equal(f.events.includes('http'),false);assert.equal(f.state.phase,'uncertain');
});
test('invalid decisions settle known usage but unknown transport retains uncertain hold',async()=>{
 for(const options of [{badDecision:true},{unknownCost:true}]){
  const f=fixture(options);await assert.rejects(runShadowInvocation({runId,config,...f}),e=>!e.message.includes('private'));
  assert.equal(f.events.filter(x=>x==='http').length,1);assert.equal(f.state.phase,'uncertain');
  assert.ok(f.events.includes(options.badDecision?'settled':'uncertain'));
 }
});
test('uncertain reserve or dispatch SQL never starts HTTP or retries',async()=>{
 for(const failing of ['reserve','dispatch']){
  const f=fixture();const base=f.query;let attempts=0;
  const query=async(sql,args)=>{if(sql.includes(`.${failing}(`)){attempts++;throw Error('private SQL response lost');}return base(sql,args);};
  await assert.rejects(runShadowInvocation({runId,config,...f,query}),e=>!e.message.includes('private'));
  assert.equal(attempts,1);assert.equal(f.events.includes('http'),false);assert.equal(f.state.phase,'uncertain');
 }
});
test('busy lease exits without reading or changing run',async()=>{
 let calls=0;const result=await runShadowInvocation({runId,config,query:async(sql)=>{calls++;assert.ok(sql.includes('.claim('));return {rows:[{value:null}]};},fetcher:()=>{throw Error('must not send');}});
 assert.equal(result.status,'busy');assert.equal(calls,1);
});
test('invalid transport limits or too-short lease fail before SQL',async()=>{
 for(const extra of [{leaseSeconds:1,timeoutMs:1000},{timeoutMs:30001},{maxResponseBytes:0}]){
  let calls=0;await assert.rejects(runShadowInvocation({runId,config:{...config,...extra},query:async()=>{calls++;throw Error('not expected')},fetcher:async()=>{throw Error('not expected')}}));assert.equal(calls,0);
 }
});
