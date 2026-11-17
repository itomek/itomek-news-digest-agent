import {PGlite} from '@electric-sql/pglite';import {Client} from 'pg';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {OWNER_DID,BOT_DID,runOwnerFeedbackInvocation} from '../supabase/functions/news-agent/owner-feedback.mjs';globalThis.crypto??=webcrypto;
let db;const connection=process.env.WARPCORE_TEST_DATABASE_URL;if(connection){const u=new URL(connection);if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!='/warpcore_test'||u.search||u.hash)throw Error('Disposable loopback warpcore_test required');const client=new Client({connectionString:u.href});await client.connect();db={query:(s,args=[])=>client.query(s,args.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v)),exec:s=>client.query(s),close:()=>client.end()};}else db=new PGlite();
const q=async(s,a=[])=>(await db.query(s,a)).rows,value=async(s,a=[])=>(await q(s,a))[0].v;
const checkpoint=()=>value('select public.warpcore_owner_feedback_checkpoint() v');const record=(r,p)=>value('select public.warpcore_owner_feedback_record_page($1,$2) v',[r,p]);
const uri=(did,n=2)=>`at://${did}/app.bsky.feed.post/3m3e4a2b${String(n).padStart(5,'2')}`,cid='bafyre'+'a'.repeat(53);
try{
 assert.equal(await value("select to_regnamespace('owner_feedback') is null v"),true,'Refuse existing fixture');
 await db.exec("do $$declare role_name text;begin foreach role_name in array array['anon','authenticated','service_role'] loop if not exists(select 1 from pg_roles where rolname=role_name) then execute format('create role %I',role_name);end if;end loop;end $$");await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/owner-feedback.sql',import.meta.url),'utf8'));
 assert.deepEqual(await checkpoint(),{enabled:false});assert.equal(await record(0,{}),null);
 await db.exec('update owner_feedback.settings set enabled=true');await db.exec('set role service_role');const first=await checkpoint();assert.equal(Date.parse(first.windowUntil)-Date.parse(first.windowSince),7*86400000);
 const indexed=new Date(Date.parse(first.windowUntil)-60000).toISOString(),created=new Date(Date.parse(indexed)-1000).toISOString();
 const post={uri:uri(OWNER_DID),cid,author:{did:OWNER_DID},indexedAt:indexed,record:{$type:'app.bsky.feed.post',text:'Public feedback, not policy authority.',createdAt:created,reply:{root:{uri:uri(BOT_DID),cid},parent:{uri:uri(BOT_DID),cid}}}};
 let captured;const adapter={checkpoint:async()=>first,recordPage:async(r,p)=>{captured=p;return record(r,p);}};
 assert.equal((await runOwnerFeedbackInvocation({db:adapter,fetcher:async()=>Response.json({feed:[{post}],cursor:'page2'})})).coverage,'pending');
 assert.equal(await record(first.revision,captured),null,'Stale page loses CAS before validation');
 const second=await checkpoint();assert.equal(second.cursor,'page2');assert.equal(second.revision,first.revision+1);
 const duplicate={...captured,requestCursor:'page2',nextCursor:'page3'};const duplicateResult=await record(second.revision,duplicate);assert.equal(duplicateResult.coverage,'pending');assert.equal(duplicateResult.newCount,0);assert.equal(duplicateResult.duplicateCount,1);
 await db.exec('reset role');assert.equal((await q('select count(*)::int n from owner_feedback.items'))[0].n,1);await db.exec('set role service_role');
 const third=await checkpoint();const changed=structuredClone(duplicate);changed.requestCursor='page3';changed.nextCursor='page4';changed.entries[0].cid='bafyre'+'b'.repeat(53);await assert.rejects(()=>record(third.revision,changed),/Immutable/);
 for(const mutate of [p=>p.ownerDid=BOT_DID,p=>p.entries[0].authorDid=BOT_DID,p=>p.entries[0].uri=uri(BOT_DID),p=>{p.entries[0].rootUri=uri(OWNER_DID);p.entries[0].parentUri=uri(OWNER_DID);},p=>p.entries[0].untrusted=false]){const bad=structuredClone(duplicate);bad.requestCursor='page3';bad.nextCursor='page4';mutate(bad);await assert.rejects(()=>record(third.revision,bad),/Invalid/);}
 // Two distinct eligible replies tied exactly at the inclusive window boundary
 // occupy successive API pages. Neither page proves that older history began.
 const tiedPost=structuredClone(post);tiedPost.uri=uri(OWNER_DID,3);tiedPost.indexedAt=first.windowSince;tiedPost.record.createdAt=first.windowSince;
 const boundaryAdapter={checkpoint,recordPage:record};
 const boundary1=await runOwnerFeedbackInvocation({db:boundaryAdapter,fetcher:async()=>Response.json({feed:[{post:tiedPost}],cursor:'boundary2'})});
 assert.equal(boundary1.coverage,'pending');assert.equal(boundary1.recordedCount,1);assert.equal((await checkpoint()).cursor,'boundary2');
 tiedPost.uri=uri(OWNER_DID,4);
 const boundary2=await runOwnerFeedbackInvocation({db:boundaryAdapter,fetcher:async()=>Response.json({feed:[{post:tiedPost}],cursor:'older'})});
 assert.equal(boundary2.coverage,'pending');assert.equal(boundary2.recordedCount,1);const beforeEnd=await checkpoint();assert.equal(beforeEnd.cursor,'older');
 const end={...duplicate,requestCursor:'older',nextCursor:null,indexedTimes:[new Date(Date.parse(first.windowSince)-1).toISOString()],entries:[],coverage:'cutoff_reached'};const complete=await record(beforeEnd.revision,end);assert.equal(complete.coverage,'cutoff_reached');assert.equal(complete.complete,true);
 await db.exec('reset role');assert.equal((await q('select count(*)::int n from owner_feedback.items'))[0].n,3,'Both tied replies survive durable capture');await db.exec('set role service_role');
 const fresh=await checkpoint();assert.equal(fresh.cursor,null);assert.equal(fresh.complete,false);assert.equal(fresh.lastCoverage,'cutoff_reached');assert.ok(fresh.revision>complete.revision);
 const exhausted={...end,windowSince:fresh.windowSince,windowUntil:fresh.windowUntil,requestCursor:null,indexedTimes:[],coverage:'feed_exhausted_before_cutoff'};assert.equal((await record(fresh.revision,exhausted)).coverage,'feed_exhausted_before_cutoff');
 if(connection){
  // Prove an actual row-lock/CAS race: the loser waits, then refuses its stale
  // revision before interpreting even a malformed payload.
  await db.exec('reset role');const b=new Client({connectionString:connection});await b.connect();
  try{
   await b.query("set statement_timeout='5s'");const race=await checkpoint(),pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
   const empty={...exhausted,windowSince:race.windowSince,windowUntil:race.windowUntil,requestCursor:null,fetchedAt:new Date().toISOString()};
   await db.exec('begin');await record(race.revision,empty);
   const pending=b.query('select public.warpcore_owner_feedback_record_page($1,$2) v',[race.revision,JSON.stringify({})]).then(result=>({result}),error=>({error}));
   let blocked=false;for(let i=0;i<80;i++){if(await value('select wait_event_type v from pg_stat_activity where pid=$1',[pid])==='Lock'){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}
   assert.equal(blocked,true,'Observe competing feedback checkpoint row lock');await db.exec('commit');const loser=await pending;assert.equal(loser.error,undefined);assert.equal(loser.result.rows[0].v,null);
  }finally{await db.exec('rollback');await b.end();await db.exec('set role service_role');}
 }
 for(const table of ['settings','checkpoint','items','page_receipts'])await assert.rejects(()=>q('select * from owner_feedback.'+table),/permission/);
 await db.exec('reset role');await q("update owner_feedback.items set status='operator_review'");assert.equal((await q('select status from owner_feedback.items'))[0].status,'operator_review');await assert.rejects(()=>q('delete from owner_feedback.page_receipts'),/immutable/i);await assert.rejects(()=>q("update owner_feedback.items set text='Changed'"),/immutable/i);await assert.rejects(()=>q('delete from owner_feedback.items'),/immutable/i);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(checkpoint,/permission/);await assert.rejects(()=>record(0,{}),/permission/);await db.exec('reset role');}
 console.log('PASS: pinned public owner replies, immutable URI/CID dedup, revision CAS, resumable seven-day coverage, explicit feed-exhaustion gaps and private grants');
}finally{await db.close();}
