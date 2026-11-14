import test from 'node:test';
import assert from 'node:assert/strict';
import {newShadowRun,advanceShadowRun} from './workflow.mjs';
const make=(i)=>({id:i.toString(16).padStart(64,'0'),sourceUrl:'https://example.com/'+i,discoveryText:'Public discovery item '+i,sourceType:'rss'});
function store(initial){let value=structuredClone(initial);return {read:()=>structuredClone(value),save:async(next,revision)=>{assert.equal(value.revision,revision);value=structuredClone(next);}};}
const run=()=>newShadowRun({runId:'unit-run',scanStartedAt:'2026-11-14T19:00:00Z'});
test('405 candidates scan to terminal page and review across resumable bounded invocations',async()=>{
 const db=store(run()); const items=Array.from({length:405},(_,i)=>make(i+1));let calls=0;const stamps=[];
 const fetchPage=async({cursor,scanStartedAt})=>{stamps.push(scanStartedAt);return items.filter(x=>cursor===null||x.id>cursor).slice(0,100);};
 const review=async(batch)=>{calls++;assert.equal(db.read().phase,'reviewing');return batch.map(c=>({id:c.id,action:'verify',reason:'Needs evidence'}));};
 while(db.read().phase!=='complete')await advanceShadowRun(db.read(),{save:db.save,fetchPage,review},{pageSteps:2,reviewBatchSize:25});
 assert.equal(db.read().candidates.length,405);assert.equal(db.read().decisions.length,405);assert.equal(calls,17);assert.equal(new Set(stamps).size,1);assert.equal(db.read().publishingEnabled,false);
});
test('model failure becomes uncertain and cannot be automatically retried',async()=>{
 const db=store({...run(),phase:'review',cursor:make(1).id,candidates:[make(1)]});let calls=0;
 await assert.rejects(advanceShadowRun(db.read(),{save:db.save,review:async()=>{calls++;throw Error('timeout');}}),/timeout/);
 assert.equal(db.read().phase,'uncertain');
 await assert.rejects(advanceShadowRun(db.read(),{save:db.save,review:async()=>{calls++;}}),/manual reconciliation/);
 assert.equal(calls,1);
});
test('crash after reservation remains reviewing, never repeats paid request',async()=>{
 const db=store({...run(),phase:'reviewing',cursor:make(1).id,candidates:[make(1)],activeBatch:[make(1).id]});
 await assert.rejects(advanceShadowRun(db.read(),{save:db.save}),/manual reconciliation/);
});
test('missing, duplicate and unknown model decisions cannot complete a batch',async()=>{
 for(const result of [[],[{id:make(99).id,action:'skip',reason:'Other'}],[{id:make(1).id,action:'skip',reason:'Routine'},{id:make(1).id,action:'skip',reason:'Duplicate'}]]){
 const db=store({...run(),phase:'review',cursor:make(1).id,candidates:[make(1)]});
 await assert.rejects(advanceShadowRun(db.read(),{save:db.save,review:async()=>result}));assert.equal(db.read().phase,'uncertain');
 }
});
test('scan rejects nonascending keys and never claims a failed scan complete',async()=>{
 const db=store(run());await assert.rejects(advanceShadowRun(db.read(),{save:db.save,fetchPage:async()=>[make(2),make(1)]}),/Invalid candidate page/);assert.equal(db.read().phase,'scan');
});
test('a compare-and-swap conflict happens before model invocation',async()=>{
 let calls=0;await assert.rejects(advanceShadowRun({...run(),phase:'review',cursor:make(1).id,candidates:[make(1)]},{save:async()=>{throw Error('conflict');},review:async()=>{calls++;}}),/conflict/);assert.equal(calls,0);
});

test('corrupt persisted coverage cannot skip an unreviewed candidate',async()=>{
 for(const patch of [{decisions:[{id:make(99).id,action:'skip',reason:'Unknown'}]},{cursor:null},{scanStartedAt:'bad'},{runId:''},{candidates:[make(2),make(1)]},{phase:'complete'}]){
 let calls=0;const prior={...run(),phase:'review',cursor:make(1).id,candidates:[make(1)],...patch};
 await assert.rejects(advanceShadowRun(prior,{save:async()=>{calls++;},review:async()=>{calls++;}}),/Invalid run state/);assert.equal(calls,0);
 }
});
test('two overlapping invocations with atomic CAS perform one model request',async()=>{
 const db=store({...run(),phase:'review',cursor:make(1).id,candidates:[make(1)]});
 const previous=db.read();let calls=0;
 const services={save:db.save,review:async batch=>{calls++;return batch.map(c=>({id:c.id,action:'skip',reason:'Routine'}));}};
 const result=await Promise.allSettled([advanceShadowRun(previous,services),advanceShadowRun(previous,services)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(db.read().decisions.length,1);
});
