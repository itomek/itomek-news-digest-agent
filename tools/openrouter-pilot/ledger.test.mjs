import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {openPilotLedger} from './ledger.mjs';
const hash=n=>n.toString(16).padStart(64,'0');
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-ledger-'));try{return fn(path.join(dir,'private','campaign.sqlite'),dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const reserve=(ledger,n,usd=0.01)=>ledger.reserve({requestHash:hash(n),model:'fixture/offline-model',reservationUsd:usd});
test('hardcoded campaign permits 24 attempts maximum, reserves before dispatch and rounds up microUSD',()=>fixture(file=>{
 const ledger=openPilotLedger(file);
 try{
  for(let i=1;i<=24;i++){const id=reserve(ledger,i,0.0000001);assert.equal(ledger.snapshot().heldMicrousd,'1');ledger.markDispatched(id);ledger.settle(id,{costUsd:0.00000001,outcome:'success'});}
  const s=ledger.snapshot();assert.equal(s.campaignId,'2026-11-15');assert.equal(s.budgetMicrousd,'2000000');assert.equal(s.maxAttempts,24);assert.equal(s.attemptCount,24);assert.equal(s.spentMicrousd,'24');assert.equal(s.heldMicrousd,'0');
  assert.throws(()=>reserve(ledger,25),/attempt limit/i);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
 }finally{ledger.close();}
}));
test('spent plus held never exceeds $2 across connections and reopening',()=>fixture(file=>{
 let a=openPilotLedger(file);const first=reserve(a,1,1.32);a.markDispatched(first);a.settle(first,{costUsd:1.3,outcome:'success'});a.close();
 a=openPilotLedger(file);const b=openPilotLedger(file);
 try{assert.throws(()=>reserve(b,2,0.7000001),/budget/i);const second=reserve(a,2,0.7);assert.equal(b.snapshot().heldMicrousd,'700000');assert.throws(()=>reserve(b,3,0.01),/in.flight/i);a.markDispatched(second);a.settle(second,{costUsd:0.7,outcome:'success'});assert.equal(b.snapshot().spentMicrousd,'2000000');assert.throws(()=>reserve(b,3,0.000001),/budget/i);}finally{a.close();b.close();}
}));
test('uncertain/dispatched/reserved attempts prevent replacement across restart; late known usage settles',()=>fixture(file=>{
 let ledger=openPilotLedger(file);const id=reserve(ledger,1,0.2);assert.throws(()=>reserve(ledger,2),/in.flight/i);ledger.markDispatched(id);assert.throws(()=>ledger.markDispatched(id),/dispatch|retry/i);ledger.markUncertain(id);ledger.close();
 ledger=openPilotLedger(file);
 try{assert.throws(()=>reserve(ledger,2),/in.flight/i);assert.equal(ledger.snapshot().heldMicrousd,'200000');ledger.settle(id,{costUsd:0.1,outcome:'failure'});assert.equal(ledger.snapshot().heldMicrousd,'0');assert.equal(ledger.snapshot().spentMicrousd,'100000');ledger.settle(id,{costUsd:0.1,outcome:'failure'});assert.throws(()=>ledger.settle(id,{costUsd:0.10000000001,outcome:'failure'}),/immutable/i);assert.throws(()=>ledger.settle(id,{costUsd:0.1,outcome:'success'}),/immutable/i);assert.throws(()=>reserve(ledger,1),/duplicate|reserved|retry/i);assert.ok(reserve(ledger,2));}finally{ledger.close();}
}));
test('overspend records all actual cost and permanently blocks further calls',()=>fixture(file=>{
 const ledger=openPilotLedger(file);
 try{const id=reserve(ledger,1,0.1);ledger.markDispatched(id);ledger.settle(id,{costUsd:1e300,outcome:'failure'});const s=ledger.snapshot();assert.equal(s.blocked,true);assert.equal(s.heldMicrousd,'0');assert.equal(s.spentMicrousd,'1'+'0'.repeat(306));assert.throws(()=>reserve(ledger,2),/blocked/i);}finally{ledger.close();}
}));
test('an actual overage blocks even when rounded reservation and spend occupy the same microUSD',()=>fixture(file=>{
 const ledger=openPilotLedger(file);try{const id=reserve(ledger,1,0.10000001);ledger.markDispatched(id);ledger.settle(id,{costUsd:0.10000002,outcome:'success'});assert.equal(ledger.snapshot().blocked,true);assert.equal(ledger.snapshot().spentMicrousd,'100001');assert.throws(()=>reserve(ledger,2),/blocked/i);}finally{ledger.close();}
}));
test('configuration cannot be raised and metadata drift is rejected on reopen',()=>fixture(file=>{
 const ledger=openPilotLedger(file);ledger.close();const db=new DatabaseSync(file);db.prepare('update campaign set max_attempts=25').run();db.close();assert.throws(()=>openPilotLedger(file),/campaign|configuration/i);
}));
test('UTC date changes never reset the campaign ledger',()=>fixture(file=>{
 let ledger=openPilotLedger(file);const id=reserve(ledger,1,1.5);ledger.markDispatched(id);ledger.settle(id,{costUsd:1.5,outcome:'success'});ledger.close();
 const original=Date.now;Date.now=()=>Date.UTC(2031,0,1);
 try{ledger=openPilotLedger(file);assert.equal(ledger.snapshot().attemptCount,1);assert.throws(()=>reserve(ledger,2,0.500001),/budget/i);}finally{Date.now=original;ledger.close();}
}));
test('invalid reservations and settlement without dispatch cannot consume ledger',()=>fixture(file=>{
 const ledger=openPilotLedger(file);
 try{for(const usd of [0,-1,NaN,Infinity,2.000001])assert.throws(()=>reserve(ledger,1,usd),/reservation/i);assert.throws(()=>ledger.reserve({requestHash:'bad',model:'fixture/model',reservationUsd:0.1}),/request/i);assert.throws(()=>ledger.reserve({requestHash:hash(1),model:'bad\nmodel',reservationUsd:0.1}),/model/i);const id=reserve(ledger,1);assert.throws(()=>ledger.settle(id,{costUsd:0,outcome:'success'}),/dispatch/i);ledger.markDispatched(id);for(const costUsd of [-1,Infinity,NaN])assert.throws(()=>ledger.settle(id,{costUsd,outcome:'failure'}),/cost/i);assert.throws(()=>ledger.settle(id,{costUsd:0,outcome:'other'}),/outcome/i);assert.equal(ledger.snapshot().attemptCount,1);}finally{ledger.close();}
}));
test('does not chmod existing nonprivate parents or follow file symlinks',()=>fixture((file,dir)=>{
 const publicDir=path.join(dir,'public');fs.mkdirSync(publicDir,{mode:0o755});assert.throws(()=>openPilotLedger(path.join(publicDir,'ledger.sqlite')),/private|permission/i);assert.equal(fs.statSync(publicDir).mode&0o777,0o755);
 const target=path.join(dir,'target');fs.writeFileSync(target,'untouched');const link=path.join(dir,'link');fs.symlinkSync(target,link);assert.throws(()=>openPilotLedger(link),/symbolic|symlink|regular/i);assert.equal(fs.readFileSync(target,'utf8'),'untouched');
}));
test('separate workers contend atomically: at most one can reserve',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-ledger-workers-')),file=path.join(dir,'campaign.sqlite');const ledger=openPilotLedger(file);ledger.close();
 const moduleUrl=new URL('./ledger.mjs',import.meta.url).href;
 const worker=n=>new Promise((resolve,reject)=>{const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openPilotLedger}=await import(workerData.moduleUrl);let ledger;try{ledger=openPilotLedger(workerData.file);const id=ledger.reserve({requestHash:workerData.hash,model:'fixture/offline-model',reservationUsd:1.5});parentPort.postMessage({ok:true,id});}catch{parentPort.postMessage({ok:false});}finally{ledger?.close();}})();`,{eval:true,workerData:{moduleUrl,file,hash:hash(n)}});w.once('message',resolve);w.once('error',reject);});
 try{const results=await Promise.all([worker(1),worker(2)]);assert.equal(results.filter(r=>r.ok).length,1);const reopened=openPilotLedger(file);try{assert.equal(reopened.snapshot().attemptCount,1);assert.equal(reopened.snapshot().heldMicrousd,'1500000');}finally{reopened.close();}}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
