import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
const q=async(s,a=[])=>(await db.query(s,a)).rows;
import {newShadowRun,advanceShadowRun} from '../supabase/functions/news-agent/workflow.mjs';
const id='00000000-0000-4000-8000-000000000001';
const candidate={id:'a'.repeat(64),sourceUrl:'https://example.com/shadow-test',sourceType:'rss',sourceCreatedAt:'2026-11-14T19:00:00Z',discoveryText:'Synthetic SQL test candidate.'};
const initial={...newShadowRun({runId:id,scanStartedAt:'2026-11-14T20:00:00Z'}),phase:'reviewing',activeBatch:[candidate.id],cursor:candidate.id,candidates:[candidate]};
const state=revision=>({...initial,revision});
try {
 await db.exec('create role anon; create role authenticated; create role service_role;');
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql',import.meta.url),'utf8'));
 await q("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,1)");
 await q("insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,0.8)",[id,initial]);
 for(const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(()=>q('select shadow_agent.claim($1,60)',[id]),/permission denied/);
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 await assert.rejects(()=>q('select * from shadow_agent.runs'),/permission denied/);
 const lease=(await q('select shadow_agent.claim($1,60) as token',[id]))[0].token;
 assert.ok(lease);assert.equal((await q('select shadow_agent.claim($1,60) as token',[id]))[0].token,null);
 const save=async(rev,next,token=lease)=>(await q('select shadow_agent.save($1,$2,$3,$4) as ok',[id,token,rev,next]))[0].ok;
 assert.equal(await save(null,state(1)),false);
 await assert.rejects(()=>save(0,state(1)),/transition/i);
 assert.equal(await save(0,{...state(1),phase:'uncertain'}),true);
 assert.equal(await save(0,state(1)),false);
 await db.exec('reset role');
 await q('update shadow_agent.runs set state=$2 where id=$1',[id,state(1)]);
 await db.exec('set role service_role');
 await assert.rejects(()=>save(1,{runId:id,revision:2,publishingEnabled:true}),/Invalid/);
 await assert.rejects(()=>save(1,{...state(2),scanStartedAt:'2020-01-01'}),/Invalid/);
 await assert.rejects(()=>save(1,{...state(2),policyVersion:'other'}),/Invalid/);
 const reserve=async(hash='a'.repeat(64),cost=0.6)=>(await q('select shadow_agent.reserve($1,$2,$3,$4) as attempt',[id,lease,hash,cost]))[0].attempt;
 await db.exec('reset role');await db.exec('begin');
 await q('update shadow_agent.budgets set limit_credits=null,spent_credits=25,held_credits=10');
 const beforeUnlimited=(await q('select spent_credits,held_credits from shadow_agent.budgets'))[0];
 await db.exec('set role service_role');const unlimitedAttempt=await reserve();assert.ok(unlimitedAttempt,'Uncapped daily ledger can reserve beyond former daily/lifetime caps');
 await db.exec('savepoint duplicate_guard');await assert.rejects(()=>reserve(),/already reserved/,'Removing caps never permits duplicate paid requests');await db.exec('rollback to savepoint duplicate_guard');
 await db.exec('reset role');const afterUnlimited=(await q('select spent_credits::float spent,held_credits::float held from shadow_agent.budgets'))[0];assert.equal(afterUnlimited.spent,Number(beforeUnlimited.spent_credits));assert.equal(afterUnlimited.held,Number(beforeUnlimited.held_credits)+.6,'Reservations remain accounted');
 await db.exec('rollback');await db.exec('set role service_role');
 const attempt=await reserve();assert.ok(attempt);
 await assert.rejects(()=>reserve(),/already reserved/);
 await assert.rejects(()=>reserve('b'.repeat(64),0.1),/checkpoint/);
 const dispatch=async()=> (await q('select shadow_agent.dispatch($1,$2) as ok',[attempt,lease]))[0].ok;
 assert.equal(await dispatch(),true);assert.equal(await dispatch(),false);
 const settle=async(status,cost=null)=>(await q('select shadow_agent.settle($1,$2,$3,$4) as ok',[attempt,lease,status,cost]))[0].ok;
 assert.equal(await settle('uncertain'),true);assert.equal(await settle('uncertain'),true);
 await assert.rejects(()=>reserve('c'.repeat(64),0.1),/checkpoint/);
 await assert.rejects(()=>save(1,{...state(2),activeBatch:['b'.repeat(64)]}),/Invalid|transition/);
 await assert.rejects(()=>save(1,state(2)),/transition/);
 assert.equal(await save(1,{...state(2),phase:'uncertain'}),true);
 assert.equal(await settle('settled',0.9),true);assert.equal(await settle('settled',0.9),true);
 await assert.rejects(()=>settle('settled',0.1),/Immutable/);
 await assert.rejects(()=>reserve('d'.repeat(64),0.01),/reviewing/);
 await db.exec('reset role');
 assert.equal((await q('select spent_credits::float as n from shadow_agent.budgets'))[0].n,0.9);
 await q("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[id]);
 await db.exec('set role service_role');
 const newLease=(await q('select shadow_agent.claim($1,60) as token',[id]))[0].token;
 assert.notEqual(newLease,lease);
 assert.equal(await save(2,state(3)),false);
 await assert.rejects(()=>save(2,state(3),newLease),/transition/);
 await db.exec('reset role');
 const id2='00000000-0000-4000-8000-000000000002';
 const start=newShadowRun({runId:id2,scanStartedAt:'2026-11-14T20:00:00Z'});
 await q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,0.5)',[id2,start]);
 await db.exec('set role service_role');
 const t2=(await q('select shadow_agent.claim($1,60) as t',[id2]))[0].t;
 await db.exec('reset role');
 await q("insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date-1,1)");
 const historical=(await q("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,checkpoint_revision) values ($1,(now() at time zone 'utc')::date-1,$2,$3,0.1,0) returning id",[id2,t2,'f'.repeat(64)]))[0].id;
 await db.exec('set role service_role');
 assert.equal((await q('select shadow_agent.dispatch($1,$2) as ok',[historical,t2]))[0].ok,false);
 await assert.rejects(()=>q('select shadow_agent.reserve($1,$2,$3,0.1)',[id2,t2,'b'.repeat(64)]),/reviewing/);
 const loaded=(await q('select shadow_agent.load($1) as s',[id2]))[0].s;
 const next=await advanceShadowRun(loaded,{fetchPage:async()=>[],save:async(next,rev)=>{const ok=(await q('select shadow_agent.save($1,$2,$3,$4) as ok',[id2,t2,rev,next]))[0].ok;assert.equal(ok,true);}});
 assert.equal(next.phase,'review');
 assert.deepEqual((await q('select shadow_agent.load($1) as s',[id2]))[0].s,next);
 // Exercise the legal state machine end to end, including two distinct batches.
 await db.exec('reset role');
 // New isolated accounting fixture after the explicit overspend breaker test.
 await q("update shadow_agent.budgets set blocked=false,limit_credits=2 where day=(now() at time zone 'utc')::date");
 const id3='00000000-0000-4000-8000-000000000003';
 let checkpoint=newShadowRun({runId:id3,scanStartedAt:'2026-11-14T20:00:00Z'});
 const second={...candidate,id:'b'.repeat(64)};
 await q('insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,0.5)',[id3,checkpoint]);
 await db.exec('set role service_role');
 const t3=(await q('select shadow_agent.claim($1,60) as t',[id3]))[0].t;
 const persist=async(next,rev)=>assert.equal((await q('select shadow_agent.save($1,$2,$3,$4) as ok',[id3,t3,rev,next]))[0].ok,true);
 const invalid=next=>assert.rejects(()=>persist({...next,revision:checkpoint.revision+1},checkpoint.revision),/Invalid shadow/);
 await invalid({...checkpoint,phase:'complete'}); // No terminal scan attestation.
 const numericCandidate=JSON.stringify({...checkpoint,revision:1,candidates:[candidate],cursor:'1'.repeat(64)}).replace(JSON.stringify(candidate.id),'1'.repeat(64));
 await assert.rejects(()=>q('select shadow_agent.save($1,$2,0,$3::jsonb)',[id3,t3,numericCandidate]),/Invalid shadow/);
 const numericDecision=JSON.stringify({...checkpoint,revision:1,phase:'review',candidates:[{...candidate,id:'1'.repeat(64)}],cursor:'1'.repeat(64),decisions:[{id:'1'.repeat(64),action:'skip',reason:'Synthetic numeric decision identity'}]}).replace('\"decisions\":[{\"id\":'+JSON.stringify('1'.repeat(64)), '\"decisions\":[{\"id\":'+'1'.repeat(64));
 await assert.rejects(()=>q('select shadow_agent.save($1,$2,0,$3::jsonb)',[id3,t3,numericDecision]),/Invalid shadow state/);
 checkpoint=await advanceShadowRun(checkpoint,{save:persist,fetchPage:async()=>[candidate,second]});
 await invalid({...checkpoint,candidates:[second,candidate],cursor:candidate.id});
 await invalid({...checkpoint,candidates:[second],cursor:second.id});
 checkpoint=await advanceShadowRun(checkpoint,{save:persist,fetchPage:async()=>[]});
 await invalid({...checkpoint,phase:'scan'});
 await invalid({...checkpoint,phase:'complete'}); // Cannot skip uncovered candidates.
 await invalid({...checkpoint,phase:'reviewing',activeBatch:[second.id]});
 await invalid({...checkpoint,candidates:[{...candidate,id:123},second],phase:'reviewing',activeBatch:[candidate.id]});
 await invalid({...checkpoint,candidates:[{...candidate,sourceUrl:'https://user:password@example.com'},second],phase:'reviewing',activeBatch:[candidate.id]});
 const review=async batch=>{
  const active=(await q('select shadow_agent.load($1) as s',[id3]))[0].s;
  await assert.rejects(()=>persist({...active,revision:active.revision+1},active.revision),/transition/);
  await assert.rejects(()=>persist({...active,phase:'review',activeBatch:null,revision:active.revision+1,
   decisions:[...active.decisions,{id:batch[0].id,action:'skip',reason:'Forged unbilled completion'}]},active.revision),/transition/);
  const attempt=(await q('select shadow_agent.reserve($1,$2,$3,0.01) as a',[id3,t3,batch[0].id]))[0].a;
  assert.equal((await q('select shadow_agent.dispatch($1,$2) as ok',[attempt,t3]))[0].ok,true);
  assert.equal((await q("select shadow_agent.settle($1,$2,'settled',0.01) as ok",[attempt,t3]))[0].ok,true);
  await assert.rejects(()=>persist({...active,phase:'review',activeBatch:null,revision:active.revision+1,decisions:[]},active.revision),/transition/);
  await assert.rejects(()=>persist({...active,phase:'review',activeBatch:null,revision:active.revision+1,decisions:[...active.decisions,{id:batch[0].id,action:'publish',reason:'Invalid authority'}]},active.revision),/Invalid shadow/);
  return batch.map(c=>({id:c.id,action:'skip',reason:'Synthetic contract decision.'}));
 };
 for(let batch=0;batch<2;batch++) {
  checkpoint=await advanceShadowRun(checkpoint,{save:persist,review},{reviewBatchSize:1});
  await invalid({...checkpoint,phase:'reviewing',activeBatch:[candidate.id]}); // No old batch replay.
  await invalid({...checkpoint,candidates:[...checkpoint.candidates,{...candidate,id:'c'.repeat(64)}],cursor:'c'.repeat(64),phase:'reviewing',activeBatch:['c'.repeat(64)]});
 }
 checkpoint=await advanceShadowRun(checkpoint,{save:persist});
 assert.equal(checkpoint.phase,'complete');
 await invalid(checkpoint); // Completed/uncertain checkpoints cannot mint revisions.
 console.log('shadow state: permissions, fenced CAS, reserve/dispatch, uncertainty, idempotence and overspend passed');
} finally { await db.close(); }
