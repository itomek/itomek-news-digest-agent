// Disposable embedded PostgreSQL only; no source/model HTTP or live credentials.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {POLICY_VERSION} from '../supabase/functions/news-agent/policy.mjs';
const db=new PGlite();
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const seed=runId=>({storageKind:'paged-v1',runId,scanStartedAt:'2026-11-14T20:00:00Z',policyVersion:POLICY_VERSION,revision:0,phase:'scan',cursor:null,candidateCount:0,reviewedCount:0,activeBatch:null,publishingEnabled:false});
const candidates=Array.from({length:405},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),sourceUrl:`https://example.com/${i}`,sourceType:'rss',sourceCreatedAt:'2026-11-14T19:00:00Z',discoveryText:`Synthetic offline story ${i}. `+'x'.repeat(6000)}));
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
try {
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const file of ['shadow-state.sql','shadow-paged.sql'])await db.exec(await fs.readFile(new URL(`../supabase/functions/news-agent/sql/${file}`,import.meta.url),'utf8'));
 const run=randomUUID();
 await q("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,10)");
 await q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,5)',[run,seed(run)]);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(()=>q('select shadow_agent.paged_append($1,$2,0,$3)',[run,randomUUID(),[]]),/permission denied/);
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 for(const table of ['candidates','decisions'])await assert.rejects(()=>q(`select * from shadow_agent.${table}`),/permission denied/);
 let lease=await scalar('select shadow_agent.claim($1,60) as value',[run]);
 let state=seed(run);
 const append=(page,revision=state.revision,token=lease)=>scalar('select shadow_agent.paged_append($1,$2,$3,$4) as value',[run,token,revision,page]);
 await assert.rejects(()=>append([candidates[1],candidates[0]]),/Invalid/);
 await assert.rejects(()=>append(Array(101).fill(candidates[0])),/Invalid/);
 await assert.rejects(()=>append([{...candidates[0],discoveryText:'x'.repeat(2000000)}]),/Invalid/);
 await assert.rejects(()=>append([{...candidates[0],id:12}]),/Invalid/);
 await assert.rejects(()=>append([{...candidates[0],expected:'skip'}]),/Invalid/);
 await assert.rejects(()=>append([{...candidates[0],sourceUrl:'https://user:secret@example.com/'}]),/Invalid/);
 assert.equal(await append([candidates[0]],null),null);
 for(let offset=0;offset<candidates.length;offset+=100){
  const before=state.revision;
  state=await append(candidates.slice(offset,offset+100));
  assert.equal(state.candidateCount,Math.min(offset+100,405));
  assert.equal(await append([],before),null,'Stale CAS must not end scan');
  await assert.rejects(()=>append([candidates[offset]]),/Invalid/);
  // A fresh worker resumes solely from compact durable state.
  await admin(()=>q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[run]));
  const oldLease=lease;
  lease=await scalar('select shadow_agent.claim($1,60) as value',[run]);
  assert.equal(await append([],state.revision,oldLease),null);
  state=await scalar('select shadow_agent.load($1) as value',[run]);
  assert.ok(JSON.stringify(state).length<1000);
 }
 assert.ok(JSON.stringify(candidates).length>2000000);
 state=await append([]);
 assert.equal(state.phase,'review');
 await assert.rejects(()=>append([candidates[404]]),/phase/i);
 const preview=await scalar('select shadow_agent.paged_preview($1,$2,$3,100) as value',[run,lease,state.revision]);
 assert.deepEqual(preview,candidates.slice(0,100));
 assert.equal((await scalar('select shadow_agent.load($1) as value',[run])).revision,state.revision);
 assert.equal(await scalar('select shadow_agent.paged_preview($1,$2,$3,100) as value',[run,lease,state.revision-1]),null);
 const begin=size=>scalar('select shadow_agent.paged_begin($1,$2,$3,$4) as value',[run,lease,state.revision,size]);
 const commit=decisions=>scalar('select shadow_agent.paged_commit($1,$2,$3,$4) as value',[run,lease,state.revision,decisions]);
 await assert.rejects(()=>begin(101),/Invalid/);
 let reviewed=0;
 while(state.phase!=='complete'){
  const next=await begin(100);state=next.state;
  if(state.phase==='complete'){assert.deepEqual(next.batch,[]);break;}
  assert.equal(state.phase,'reviewing');
  assert.deepEqual(next.batch,candidates.slice(reviewed,reviewed+100));
  await assert.rejects(()=>begin(100),/phase/i);
  const decisions=next.batch.map(c=>({id:c.id,action:'skip',reason:'Synthetic offline fixture.'}));
  await assert.rejects(()=>commit(decisions),/settled/i);
  const attempt=await scalar('select shadow_agent.reserve($1,$2,$3,0.1) as value',[run,lease,state.activeBatch[0]]);
  assert.equal(await scalar('select shadow_agent.dispatch($1,$2) as value',[attempt,lease]),true);
  assert.equal(await scalar("select shadow_agent.settle($1,$2,'settled',0.01) as value",[attempt,lease]),true);
  await assert.rejects(()=>commit(decisions.slice(1)),/Invalid/);
  await assert.rejects(()=>commit([{...decisions[0],action:'publish'},...decisions.slice(1)]),/Invalid/);
  await assert.rejects(()=>commit([{...decisions[0],id:candidates[404].id},...decisions.slice(1)]),/Invalid/);
  const previousRevision=state.revision;
  state=await commit(decisions);reviewed+=decisions.length;
  assert.equal(state.reviewedCount,reviewed);
  assert.equal(await scalar('select shadow_agent.paged_commit($1,$2,$3,$4) as value',[run,lease,previousRevision,decisions]),null);
 }
 assert.equal(reviewed,405);assert.equal(state.reviewedCount,405);
 assert.equal((await admin(()=>q('select count(*)::integer as n from shadow_agent.candidates where run_id=$1',[run])))[0].n,405);
 assert.equal((await admin(()=>q('select count(*)::integer as n from shadow_agent.decisions where run_id=$1',[run])))[0].n,405);
 await assert.rejects(()=>begin(1),/phase/i);
 const empty=randomUUID();await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,1)',[empty,seed(empty)]));
 const eLease=await scalar('select shadow_agent.claim($1,60) as value',[empty]);
 const e=await scalar('select shadow_agent.paged_append($1,$2,0,$3) as value',[empty,eLease,[]]);
 const complete=await scalar('select shadow_agent.paged_begin($1,$2,$3,100) as value',[empty,eLease,e.revision]);
 assert.equal(complete.state.phase,'complete');assert.deepEqual(complete.batch,[]);
 const uncertain=randomUUID();await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,1)',[uncertain,seed(uncertain)]));
 const uLease=await scalar('select shadow_agent.claim($1,60) as value',[uncertain]);
 await scalar('select shadow_agent.paged_append($1,$2,0,$3) as value',[uncertain,uLease,[candidates[0]]]);
 await scalar('select shadow_agent.paged_append($1,$2,1,$3) as value',[uncertain,uLease,[]]);
 const active=await scalar('select shadow_agent.paged_begin($1,$2,2,100) as value',[uncertain,uLease]);
 const held=await scalar('select shadow_agent.paged_uncertain($1,$2,3) as value',[uncertain,uLease]);
 assert.deepEqual(held.activeBatch,active.state.activeBatch);
 await assert.rejects(()=>scalar('select shadow_agent.paged_begin($1,$2,4,100) as value',[uncertain,uLease]),/phase/i);
 // Prefix sizing reads a bounded window and never changes the checkpoint.
 const wide=randomUUID();await admin(()=>q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,1)',[wide,seed(wide)]));
 const wLease=await scalar('select shadow_agent.claim($1,60) as value',[wide]);
 const widePage=candidates.slice(0,2).map(c=>({...c,discoveryText:'x'.repeat(800000)}));
 await scalar('select shadow_agent.paged_append($1,$2,0,$3) as value',[wide,wLease,widePage]);
 await scalar('select shadow_agent.paged_append($1,$2,1,$3) as value',[wide,wLease,[]]);
 assert.deepEqual(await scalar('select shadow_agent.paged_preview($1,$2,2,100) as value',[wide,wLease]),widePage.slice(0,1));
 assert.equal((await scalar('select shadow_agent.load($1) as value',[wide])).revision,2);
 // A lease lost between row insertion and final checkpoint update rolls back all writes.
 const late=randomUUID();await admin(async()=>{
  await q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,1)',[late,seed(late)]);
  await db.exec(`create function shadow_agent.test_expire_insert() returns trigger language plpgsql as $$ begin
   if new.run_id='${late}'::uuid then update shadow_agent.runs set lease_until=clock_timestamp()-interval '1 second' where id=new.run_id; end if;return new;end $$;
   create trigger test_expire_insert before insert on shadow_agent.candidates for each row execute function shadow_agent.test_expire_insert();`);
 });
 const lateLease=await scalar('select shadow_agent.claim($1,60) as value',[late]);
 await assert.rejects(()=>scalar('select shadow_agent.paged_append($1,$2,0,$3) as value',[late,lateLease,[candidates[0]]]),/lease lost/i);
 assert.equal((await admin(()=>q('select count(*)::integer as n from shadow_agent.candidates where run_id=$1',[late])))[0].n,0);
 assert.deepEqual(await scalar('select shadow_agent.load($1) as value',[late]),seed(late));
 await assert.rejects(()=>scalar("select shadow_agent.paged_lock($1,$2,0,'scan') as value",[late,lateLease]),/permission denied/);
 console.log('PASS: normalized 405-candidate >2MB backlog, bounded pages, restart, exact settled batches, private immutable rows and uncertainty; no live calls');
}finally{await db.close();}
