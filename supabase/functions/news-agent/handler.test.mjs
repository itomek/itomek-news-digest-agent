import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from './handler.mjs';
const token='dedicated-producer-fixture-token-123456789';
const runId='11111111-1111-4111-8111-111111111111';
const config={enabled:true,producerToken:token};
const req=(body='{}',extra={})=>new Request('https://example.test/news-agent',{method:'POST',headers:{'x-warpcore-agent-token':token},body,...extra});
const forbidden={selectRun:()=>{throw Error('unexpected work');},runInvocation:()=>{throw Error('unexpected work');}};
test('producer contract exists, requires POST and dedicated token before work',async()=>{
 assert.equal(typeof h.handleAgent,'function');
 assert.equal((await h.handleAgent(req(null,{method:'GET'}),config,forbidden)).status,405);
 for(const headers of [{},{'x-warpcore-token':token},{'x-warpcore-agent-token':'wrong'}])assert.equal((await h.handleAgent(req('{}',{headers}),config,forbidden)).status,401);
 for(const producerToken of [undefined,'short'])assert.equal((await h.handleAgent(req(),{enabled:true,producerToken},forbidden)).status,401);
});
test('producer defaults disabled after authorization without constructing services or reading body',async()=>{
 const response=await h.handleAgent(req('{broken'),{producerToken:token},forbidden);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{mode:'disabled',publishing_enabled:false});
});
test('scheduler sends no body or empty object and service selects run independently',async()=>{
 for(const body of [null,'','{}',' \n {} ']){
  const events=[];
  const response=await h.handleAgent(req(body),config,{selectRun:async(...args)=>{assert.deepEqual(args,[]);events.push('select');return runId;},runInvocation:async(...args)=>{assert.deepEqual(args,[runId]);events.push('run');return {status:'advanced',state:{phase:'review',candidateCount:405,reviewedCount:25},apiKey:'SECRET',publishingEnabled:true};}});
  assert.equal(response.status,200);assert.deepEqual(events,['select','run']);
  assert.deepEqual(await response.json(),{mode:'shadow',status:'advanced',runId,phase:'review',candidateCount:405,reviewedCount:25,publishing_enabled:false});
 }
});
test('rejects body authority, invalid JSON and oversized input before selecting runs',async()=>{
 for(const body of ['null','[]','{"runId":"'+runId+'"}','{"enabled":true}','{"model":"override"}','{"budget":999}','{"publish":true}','{broken',' '.repeat(257)])assert.equal((await h.handleAgent(req(body),config,forbidden)).status,400);
 const response=await h.handleAgent(req('{}',{headers:{'x-warpcore-agent-token':token,'content-length':'257'}}),config,forbidden);assert.equal(response.status,400);
});
test('idle and busy are sanitized and cannot trigger a second invocation',async()=>{
 const idle=await h.handleAgent(req(),config,{selectRun:async()=>null,runInvocation:forbidden.runInvocation});
 assert.deepEqual(await idle.json(),{mode:'idle',publishing_enabled:false});
 let calls=0;const busy=await h.handleAgent(req(),config,{selectRun:async()=>runId,runInvocation:async()=>{calls++;return {status:'busy',secret:'private'};}});
 assert.equal(calls,1);assert.deepEqual(await busy.json(),{mode:'shadow',status:'busy',runId,publishing_enabled:false});
});
test('invalid service results and failures expose no details',async()=>{
 const services=[{}, {selectRun:async()=>{throw Error(token);}}, {selectRun:async()=>({runId})}, {selectRun:async()=>runId,runInvocation:async()=>{throw Error(token);}}, {selectRun:async()=>runId,runInvocation:async()=>({status:token})}, {selectRun:async()=>runId,runInvocation:async()=>({status:'advanced',state:{phase:token}})}];
 for(const service of services){const response=await h.handleAgent(req(),config,service);assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'agent_run_failed',publishing_enabled:false});}
});
test('slow request stream is bounded and cancelled without invoking service',async()=>{
 let cancelled=false;
 const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 const response=await h.handleAgent(req(body,{duplex:'half'}),config,forbidden);
 assert.equal(response.status,400);assert.equal(cancelled,true);
});
