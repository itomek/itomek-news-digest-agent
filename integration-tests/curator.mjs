import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';
const db=new PGlite();const q=async(sql,args=[])=> (await db.query(sql,args)).rows;const load=async p=>db.exec(await fs.readFile(new URL(p,import.meta.url),'utf8'));
const account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',run='00000000-0000-4000-8000-000000000001',dot='test-dot';
const at={factsVerified:true,meaningfulChange:true,scopeApproved:true};
async function seed(n){const key=n.toString(16).padStart(64,'0');await q('select warpcore_ingest($1::jsonb)',[JSON.stringify([{uri:'rss:'+n,story_key:key,source_type:'rss',source_id:'official',actor:'official',text:'Public announcement '+n,source_created_at:'2026-11-12',source_url:'https://example.com/news/'+n,source_links:['https://example.com/news/'+n]}])]);return key;}
async function snapshot(key){return (await q('select warpcore_curator_snapshot($1) as s',[key]))[0].s;}
function editorial(s){return {summary:'\nA meaningful new release is available.\u00a0',whyItMatters:'\tIt adds practical capabilities.\n',change:'New release',political:false,evidenceIds:s.evidence.map(e=>e.id),verification:{checkedAt:new Date().toISOString(),sourceUrls:s.evidence.map(e=>e.url),reason:'Verified official announcement and meaningful release.'}};}
async function submit(key,s,ed=editorial(s),r=run){return (await q('select warpcore_curator_submit($1,$2,$3,$4,$5,$6) as id',[key,s.evidence_hash,ed,at,dot,r]))[0].id;}
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await load('../supabase/migrations/20261112145946_warpcore_review_base.sql');
 await load('../supabase/migrations/20261112164434_warpcore_source_provenance.sql');
 await load('../supabase/migrations/20261112175929_warpcore_curator_inbox.sql');
 await load('../supabase/migrations/20261112192659_warpcore_tid_record_keys.sql');
 const key=await seed(1),s=await snapshot(key),ed=editorial(s),id=await submit(key,s,ed);assert.match(s.evidence_hash,/^[a-f0-9]{64}$/);assert.equal(await submit(key,s,ed),id);
 await assert.rejects(()=>submit(key,s,{...editorial(s),summary:'Changed'}),/Immutable/);
 await assert.rejects(()=>q('update warpcore_curator_inbox set editorial=$1 where id=$2',[{},id]),/immutable/);
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await assert.rejects(()=>submit(key,s),/permission/);await db.exec('reset role');}
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>q('select * from warpcore_curator_inbox'),/permission/);await assert.rejects(()=>q('select * from warpcore_curator_claim(1)'),/permission/);await db.exec('reset role');}
 await db.exec('set role service_role');const lease=(await q('select * from warpcore_curator_claim(1)'))[0];assert.equal(lease.id,id);assert.equal((await q('select * from warpcore_curator_claim(1)')).length,0);await db.exec('reset role');
 const packet=await createReviewPacket({storyKey:key,evidence:s.evidence,editorial:editorial(s)});const job={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(lease.created_at).toISOString()),storyKey:key};
 const finalize=async(token=lease.lease_token,p=packet,j=job)=>(await q('select warpcore_curator_finalize($1,$2,$3,$4) as ok',[id,token,p,j]))[0].ok;
 assert.equal(await finalize('00000000-0000-4000-8000-000000000099'),false);
 await assert.rejects(()=>finalize(lease.lease_token,{...packet,change:'forged'}),/Invalid/);
 await assert.rejects(()=>finalize(lease.lease_token,packet,{...job,recordKey:'story-'+key}),/transport/);
 await assert.rejects(()=>finalize(lease.lease_token,packet,{...job,record:{...job.record,text:'forged'}}),/transport/);
 await assert.rejects(()=>finalize(lease.lease_token,{...packet,evidence:[{...packet.evidence[0],sourceLinks:['https://evil.example/']}]}),/frozen/);
 await db.exec('set role service_role');assert.equal(await finalize(),true);assert.equal(await finalize(),false);await db.exec('reset role');
 assert.equal((await q('select state from warpcore_curator_inbox where id=$1',[id]))[0].state,'processed');
 assert.equal((await q('select status from warpcore_stories where story_key=$1',[key]))[0].status,'approved');
 assert.equal((await q('select count(*)::int as n from warpcore_publications where approved_at is not null'))[0].n,1);
 // A new evidence record invalidates an outstanding exact-evidence submission.
 const k2=await seed(2),s2=await snapshot(k2),i2=await submit(k2,s2);const l2=(await q('select * from warpcore_curator_claim(1)'))[0];await q("update warpcore_candidates set text='Changed fact' where story_key=$1",[k2]);
 assert.equal((await q('select warpcore_curator_finalize($1,$2,$3,$4) as ok',[i2,l2.lease_token,{},{}]))[0].ok,false);assert.equal((await q('select reason from warpcore_curator_inbox where id=$1',[i2]))[0].reason,'stale_evidence');
 // Expired lease gets a distinct token; stale token cannot reject it.
 const k3=await seed(3),s3=await snapshot(k3),i3=await submit(k3,s3);const old=(await q('select * from warpcore_curator_claim(1)'))[0];await q("update warpcore_curator_inbox set lease_expires_at=now()-interval '1 second' where id=$1",[i3]);const fresh=(await q('select * from warpcore_curator_claim(1)'))[0];assert.notEqual(old.lease_token,fresh.lease_token);assert.equal((await q('select warpcore_curator_fail($1,$2,$3) as ok',[i3,old.lease_token,'old']))[0].ok,false);assert.equal((await q('select warpcore_curator_fail($1,$2,$3) as ok',[i3,fresh.lease_token,'not_significant']))[0].ok,true);
 const k4=await seed(4),s4=await snapshot(k4);await assert.rejects(()=>submit(k4,{...s4,evidence_hash:'0'.repeat(64)}),/Stale/);await assert.rejects(()=>submit(k4,s4,{...editorial(s4),political:true}),/Invalid/);
 await submit(k4,s4);const k5=await seed(5),s5=await snapshot(k5);await submit(k5,s5);const k6=await seed(6),s6=await snapshot(k6);await assert.rejects(()=>submit(k6,s6),/run limit/);
 // Audit requirements and bounded global pending backlog cannot be bypassed with fresh run IDs.
 const otherRun='00000000-0000-4000-8000-000000000002';
 const noAudit=editorial(s6);delete noAudit.verification;await assert.rejects(()=>submit(k6,s6,noAudit,otherRun),/Verification/);
 await assert.rejects(()=>submit(k6,s6,{...editorial(s6),evidenceIds:[s6.evidence[0].id,s6.evidence[0].id]},otherRun),/Duplicate/);
 for(let n=16;n<38;n++){const k=await seed(n),snap=await snapshot(k);await submit(k,snap,editorial(snap),`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);}
 await assert.rejects(()=>submit(k6,s6,editorial(s6),otherRun),/backlog/);
 console.log('PASS: curator inbox immutable/idempotent submission, roles, evidence binding, lease/reclaim, exact editorial approval, stale rejection, run cap');
}finally{await db.close();}
