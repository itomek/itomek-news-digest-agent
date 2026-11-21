import test from 'node:test';import assert from 'node:assert/strict';
import {createIncidentNotifier,observationsFromReport} from './notification-incidents.mjs';
test('item identities/classes and explicit success observations are retained',()=>{
 const out=observationsFromReport({steps:[{mode:'verification',jobId:'a-b',status:'deferred',reason:'history_lock_contention'},{mode:'verification',jobId:'c-d',status:'deferred',reason:'verification_post_unpublishable'},{status:'idle'}]});
 assert.deepEqual(out.filter(x=>x.domain!=='worker').map(x=>[x.entity,x.classes]),[['a-b',['history_lock_contention']],['c-d',['verification_post_unpublishable']]]);
 assert.equal(observationsFromReport({steps:[{mode:'verification',status:'submitted'}]}).length,0,'no identity cannot recover');
 assert.ok(observationsFromReport({steps:[{mode:'verification',jobId:'a-b',status:'submitted'}]}).find(x=>x.domain==='verification').resolved.includes('history_lock_contention'));
});
test('ledger failure prevents mail and accepted claims are fenced acknowledged',async()=>{
 let sent=0;const notify=createIncidentNotifier({store:{observeBatch:async()=>{throw Error();}},send:async()=>{sent++;return {status:'sent'};}});
 assert.deepEqual(await notify({steps:[{mode:'verification',jobId:'a-b',reason:'history_lock_contention'}]}),{status:'failed'});assert.equal(sent,0);
 const calls=[],claims=[{id:1,token:'fence',event:'recovered',domain:'source',entity:'one',class:'source_network'},null];
 const worker=createIncidentNotifier({store:{observeBatch:async()=>{},claim:async()=>claims.shift(),ack:async(...args)=>calls.push(args)},send:async input=>{assert.equal(input.incident.event,'recovered');return {status:'timeout'};}});
 assert.deepEqual(await worker({}),{status:'timeout'});assert.deepEqual(calls.map(args=>args.slice(0,3)),[[1,'fence','timeout']]);
});
test('whole notifier deadline bounds hanging persistence without starting SMTP',async()=>{
 let sent=0;const start=performance.now();
 const notify=createIncidentNotifier({budgetMs:5,store:{observeBatch:()=>new Promise(()=>{})},send:async()=>{sent++;return {status:'sent'};}});
 assert.deepEqual(await notify({steps:[{mode:'verification',jobId:'one',reason:'history_lock_contention'}]}),{status:'timeout'});
 assert.equal(sent,0);assert.ok(performance.now()-start<1000);
});
test('expired send never acknowledges confirmed delivery after notifier deadline',async()=>{
 let complete,acks=0;
 const notify=createIncidentNotifier({budgetMs:5,store:{observeBatch:async()=>{},claim:async()=>({id:1,token:'fence'}),ack:async()=>acks++},send:()=>new Promise(resolve=>complete=resolve)});
 assert.deepEqual(await notify({}),{status:'timeout'});complete({status:'sent'});await new Promise(resolve=>setImmediate(resolve));assert.equal(acks,0);
});
test('roster observations use one batch and preserve persisted source generations',async()=>{
 let batches=0,sends=0;
 const notify=createIncidentNotifier({store:{observeBatch:async rows=>{batches++;assert.equal(rows.length,55);},claim:async()=>sends?null:{id:1,token:'f'},ack:async()=>{}},send:async()=>{sends++;return {status:'sent'};}});
 const report={sourceObservations:Array.from({length:55},(_,i)=>({id:'rss:'+i,generation:'a'.repeat(64),sourceGeneration:3,classes:['source_network']}))};
 assert.equal((await notify(report)).status,'sent');assert.equal(batches,1);assert.equal(sends,1);
 assert.notEqual(observationsFromReport(report)[0].configuration,observationsFromReport({sourceObservations:[{...report.sourceObservations[0],sourceGeneration:5}]})[0].configuration);
});
test('shared deadline aborts active SMTP transport and RPC body reader',async()=>{
 const {createGmailFailureNotifier}=await import('./gmail-alerts.mjs');
 const {createIncidentStore}=await import('./notification-incidents.mjs');
 let closed=0,cancelled=0;
 const notify=createIncidentNotifier({budgetMs:10,store:{observeBatch:async()=>{},claim:async()=>({id:1,token:'f',event:'opened',entity:'rss:one',class:'source_network',domain:'source'}),ack:async(_id,_token,status)=>assert.notEqual(status,'sent')},send:createGmailFailureNotifier({account:'fixture@gmail.com',password:'abcdefghijklmnop',createTransport:()=>({sendMail:()=>new Promise(()=>{}),close:()=>closed++})})});
 assert.equal((await notify({})).status,'timeout');assert.equal(closed,1);
 const store=createIncidentStore({projectUrl:'https://fixture.supabase.co',serviceKey:'synthetic'},async()=>new Response(new ReadableStream({cancel(){cancelled++;}})));
 const stuck=createIncidentNotifier({budgetMs:10,store,send:async()=>assert.fail('no send')});
 assert.equal((await stuck({sourceObservations:[{id:'rss:one',generation:'a'.repeat(64),sourceGeneration:1,classes:['source_network']}]})).status,'timeout');
 assert.equal(cancelled,1);
});
test('successful empty verification claim recovers claim availability; busy and disabled do not',()=>{
 for(const status of ['busy','disabled'])assert.deepEqual(observationsFromReport({steps:[{mode:'verification',status}]}),[]);
 const rows=observationsFromReport({steps:[{mode:'verification',status:'idle'}]});assert.equal(rows.length,1);assert.equal(rows[0].domain,'worker');assert.ok(rows[0].resolved.includes('claim_unavailable'));
});
