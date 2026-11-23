// Actual overlapping sessions; dedicated disposable loopback database only.
import {Client} from 'pg';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {setup,fixture} from './unpaid-verification-fixture.mjs';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'http://invalid');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test'||url.search||url.hash)throw Error('Dedicated disposable loopback warpcore_test required');
const clients=Array.from({length:3},()=>new Client({connectionString:url.href})),[a,b,observer]=clients;
const adapter=c=>({exec:s=>c.query(s),query:(s,args)=>c.query(s,args)});
const claim=async c=>(await c.query('select public.warpcore_verification_claim() v')).rows[0].v;
const n=async()=>Number((await observer.query('select count(*) n from shadow_agent.verification_source_retry_audit')).rows[0].n);
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='15s'")));
 await setup(adapter(a));const first=await fixture(adapter(a)),second=await fixture(adapter(a));
 await a.query('begin');const claimed=await claim(a);assert.equal(claimed.jobId,first.job);
 await assert.rejects(claim(b),e=>e.code==='55P03','Overlapping ordinary claim contends on actual verification admission lock');assert.equal(await n(),0,'Uncommitted recovery remains atomic');
 await a.query('commit');assert.equal(await n(),1);assert.equal(await claim(b),null,'Only one replacement lease is admitted');
 assert.equal((await b.query("select public.warpcore_verification_finish($1,$2,'deferred',null,'source_timeout') v",[first.job,first.oldLease])).rows[0].v,false,'Expired pre-retry worker cannot finish replacement');
 await b.query("select public.warpcore_verification_finish($1,$2,'deferred',null,'source_parser_failure')",[first.job,claimed.lease]);await b.query("update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1",[first.child]);
 // A financially authorized writer can hold the child row before its attempt
 // becomes visible. Recovery must recheck after the real row-lock wait.
 await a.query("insert into shadow_agent.budgets(day,limit_credits) values((now() at time zone 'utc')::date,1)");
 await a.query('begin');await a.query('select 1 from shadow_agent.runs where id=$1 for update',[second.child]);
 await a.query("insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,status,checkpoint_revision) values($1,(now() at time zone 'utc')::date,$2,repeat('b',64),.036045,'reserved',1)",[second.child,second.oldLease]);
 await a.query('update shadow_agent.runs set held_credits=.036045 where id=$1',[second.child]);await a.query('update shadow_agent.budgets set held_credits=.036045');
 const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid,competing=claim(b);let blocked=false;
 for(let i=0;i<100;i++){
  if((await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(blocked,true,'Recovery actually waits behind the in-flight paid child-row transaction');
 await a.query('commit');assert.equal(await competing,null,'Attempt appearing during row-lock wait is never retried');assert.equal(await n(),1);
 const money=(await observer.query('select status,reserved,actual from shadow_agent.attempts where run_id=$1',[second.child])).rows;assert.equal(money.length,1);assert.equal(money[0].status,'reserved');assert.equal(Number(money[0].reserved),.036045);assert.equal(money[0].actual,null);
 assert.equal(Number((await observer.query('select held_credits from shadow_agent.budgets')).rows[0].held_credits),.036045);
 console.log('PASS overlapping ordinary claims, one fenced retry lease, stale worker rejection, real paid-row contention and post-lock no-attempt recheck with funds preserved');
}finally{await Promise.all(clients.map(c=>c.query('rollback').catch(()=>{})));await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
