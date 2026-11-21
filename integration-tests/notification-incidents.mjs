import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec('create role anon;create role authenticated;create role service_role;');
const path=new URL('../supabase/functions/news-agent/sql/notification-incidents.sql',import.meta.url);
assert.equal(await fs.access(path).then(()=>true,()=>false),true,'durable incident SQL must exist');
await db.exec(await fs.readFile(path,'utf8'));
const observe=(entity='one',classes=['source_network'])=>db.query('select warpcore_notification_observe($1,$2,$3,$4::jsonb,$5::jsonb) as value',['source',entity,'a'.repeat(64),JSON.stringify(classes),JSON.stringify(classes.length?[]:['source_network','source_timeout'])]);
const claim=async()=> (await db.query('select warpcore_notification_claim() as value')).rows[0].value;
const ack=async(c,status='sent')=>(await db.query('select warpcore_notification_ack($1,$2,$3) as ok',[c.id,c.token,status])).rows[0].ok;
await observe();const first=await claim();assert.equal(first.event,'opened');assert.equal(await claim(),null,'concurrent worker cannot claim');
assert.equal(await ack(first),true);assert.equal(await ack(first),false,'fenced acknowledgment');await observe();assert.equal(await claim(),null,'cross invocation dedup');
await observe('two');assert.equal((await claim()).entity,'two');await observe('one',['source_timeout']);assert.equal((await claim()).class,'source_timeout','new class alerts');
await observe('one',[]);const recovered=await claim();assert.equal(recovered.event,'recovered');await ack(recovered);await ack(await claim());await observe('one',[]);assert.equal(await claim(),null);
await observe();const renewed=await claim();assert.equal(renewed.event,'opened');assert.equal(await ack(renewed,'timeout'),true);assert.equal(await claim(),null,'uncertainty has backoff');
await db.exec("update warpcore_private.notification_incidents set next_attempt_at=now()-interval '1 second', claim_until=null where entity='one' and class='source_network'");assert.equal((await claim()).event,'opened');
await db.exec("update warpcore_private.notification_incidents set claim_until=null,next_attempt_at=now()-interval '1 second',last_sent_at=now()-interval '25 hours',event='reminder' where entity='two'");assert.equal((await claim()).event,'reminder');
for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>db.query('select warpcore_notification_claim()'));await assert.rejects(()=>db.query('select * from warpcore_private.notification_incidents'));await db.exec('reset role');}
await assert.rejects(()=>observe('one',['private body']));
// Real JS normalization and fresh notifier instances exercise the database contract.
const {createIncidentNotifier}=await import('../supabase/functions/news-agent/notification-incidents.mjs');
await db.exec('truncate warpcore_private.notification_incidents');
const store={
 observeBatch:rows=>db.query('select warpcore_notification_observe_batch($1::jsonb)',[JSON.stringify(rows)]),
 claim,
 ack,
};
// Adapter uses the same scalar claim acknowledgment as PostgREST.
store.ack=(id,token,status)=>ack({id,token},status);
const mails=[];
const fresh=()=>createIncidentNotifier({store,send:async input=>{mails.push(input.incident);return {status:'sent'};}});
const report=classes=>({sourceObservations:[{id:'rss:one',generation:'a'.repeat(64),sourceGeneration:1,classes,resolved:['source_http_error','source_network','source_timeout']}]});
assert.equal((await fresh()(report(['source_http_429']))).status,'sent');
assert.equal((await fresh()(report(['source_http_500']))).status,'suppressed','transport HTTP family deduplicated across instances');
assert.equal((await fresh()({})).status,'suppressed','missing observation does not recover');
await fresh()(report([]));assert.equal(mails.at(-1).event,'recovered');
await fresh()(report([]));assert.equal(mails.length,2,'exactly one recovery');
await fresh()(report(['source_network']));assert.equal(mails.at(-1).event,'opened');
await db.exec("update warpcore_private.notification_incidents set next_attempt_at=now()-interval '1 second' where active");
await fresh()(report(['source_network']));assert.equal(mails.at(-1).event,'reminder');
await fresh()({steps:[{mode:'verification',jobId:'job-one',reason:'history_lock_contention'},{mode:'verification',jobId:'job-two',reason:'verification_post_unpublishable'}]});
assert.equal(mails.filter(x=>x.domain==='verification').length,2,'distinct items/classes alert immediately');
await fresh()({steps:[{mode:'verification',reason:'claim_unavailable'}]});assert.equal(mails.at(-1).domain,'worker');
await db.exec('truncate warpcore_private.notification_incidents');
let batches=0;const batchedStore={...store,observeBatch:async rows=>{batches++;return store.observeBatch(rows);}};
const batchNotify=createIncidentNotifier({store:batchedStore,send:async()=>({status:'sent'})});
await batchNotify({sourceObservations:Array.from({length:55},(_,n)=>({id:'rss:roster-'+n,generation:'a'.repeat(64),sourceGeneration:1,classes:['source_network']}))});
assert.equal(batches,1);assert.equal((await db.query('select count(*)::int n from warpcore_private.notification_incidents')).rows[0].n,55,'full roster persisted atomically before claims');
await db.exec('truncate warpcore_private.notification_incidents');
const sameSource=(hash,generation)=>({sourceObservations:[{id:'rss:restored',generation:hash.repeat(64),sourceGeneration:generation,classes:['source_network']}]});
const before=mails.length;await fresh()(sameSource('a',1));await fresh()(sameSource('b',2));await fresh()(sameSource('a',3));assert.equal(mails.length-before,3,'A to B to A remains three persisted configuration generations');
await db.exec("update warpcore_private.notification_incidents set active=false,recovered_at=now()-interval '91 days',next_attempt_at=now(),last_sent_at=null where configuration like '1:%'");
await fresh()(sameSource('a',3));assert.equal((await db.query('select count(*)::int n from warpcore_private.notification_incidents')).rows[0].n,2,'old resolved unsent notifications expire without SMTP');
await db.close();console.log('PASS notification incidents lifecycle and private grants');
