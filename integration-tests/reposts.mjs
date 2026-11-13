// Native repost migration and JS/SQL exact binding. Disposable database, no network.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows;
const account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',author='did:plc:abcdefghijklmnopqrstuvwx',cid='bafyre'+'a'.repeat(53),att={factsVerified:true,meaningfulChange:true,scopeApproved:true};
const migrations=['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112201145_warpcore_hourly_batch_budget.sql'];
const load=async p=>db.exec(await fs.readFile(new URL('../supabase/migrations/'+p,import.meta.url),'utf8'));
const snap=async key=>(await q('select warpcore_curator_snapshot($1) s',[key]))[0].s;
const seed=async(n,repost=true)=>{const key=n.toString(16).padStart(64,'0'),uri=`at://${author}/app.bsky.feed.post/3n256uxsaok${String.fromCharCode(97+n)}l`;await q('select warpcore_ingest($1::jsonb)',[JSON.stringify([{uri:'candidate:'+n,story_key:key,source_type:repost?'bluesky':'rss',source_id:'verified',actor:'source',text:'Original public text '+n,source_created_at:new Date().toISOString(),source_url:'https://example.com/'+n,source_links:['https://example.com/'+n],...(repost?{native_uri:uri,native_url:`https://bsky.app/profile/${author}/post/${uri.split('/').at(-1)}`,native_cid:cid,native_author_did:author}:{})}])]);return key;};
const edit=(s,repost=true)=>({...(repost?{mode:'repost'}:{summary:'A new product launches.',whyItMatters:'Available with 32 GB memory.'}),change:'New release',political:false,evidenceIds:[s.evidence[0].id],verification:{checkedAt:new Date().toISOString(),sourceUrls:[s.evidence[0].url],reason:'Verified original announcement.'}});
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');for(const m of migrations)await load(m);
 const old=await seed(9,false),before=await snap(old);await q("insert into warpcore_publications(account_did,story_key,record_key,content_hash,state,record_payload) values($1,$2,'legacy','old','uncertain',$3)",[account,old,{$type:'app.bsky.feed.post',text:'Historical'}]);const existing=(await q('select row_to_json(p) r from warpcore_publications p'));
 await load('20261113011427_warpcore_native_reposts.sql');assert.deepEqual(await snap(old),before);assert.deepEqual(await q('select row_to_json(p) r from warpcore_publications p'),existing);
 const jobs=[];
 for(let n=1;n<=6;n++){
  const repost=n%2===1,key=await seed(n,repost),s=await snap(key),ed=edit(s,repost),run=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const submit=async e=>(await q('select warpcore_curator_submit($1,$2,$3,$4,$5,$6) id',[key,s.evidence_hash,e,att,'test',run]))[0].id;
  if(repost){await assert.rejects(()=>submit({...ed,mode:'follow'}),/Unknown/);assert.equal(s.evidence[0].nativeCid,cid);}
  else await assert.rejects(()=>submit({...ed,mode:'repost'}),/native repost/);
  const id=await submit(ed);assert.equal(await submit(ed),id);const lease=(await q('select * from warpcore_curator_claim(1)'))[0];
  const packet=await createReviewPacket({storyKey:key,evidence:s.evidence,editorial:ed}),job={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(lease.created_at).toISOString()),storyKey:key};
  const finalize=async j=>(await q('select warpcore_curator_finalize($1,$2,$3,$4) ok',[id,lease.lease_token,packet,j]))[0].ok;
  if(repost)await assert.rejects(()=>finalize({...job,record:{...job.record,subject:{...job.record.subject,cid:'bafyre'+'b'.repeat(53)}}}),/transport/);
  await db.exec('set role service_role');assert.equal(await finalize(job),true);await db.exec('reset role');jobs.push(job);
 }
 // Originals and reposts share the same atomic five-attempt budget.
 for(let i=0;i<jobs.length;i++){
  const j=jobs[i],params=[account,j.storyKey,j.contentHash,j.record];const claim=await q('select * from warpcore_claim_publication($1,$2,$3,$4)',params);assert.equal(claim.length,i<5?1:0);
  if(i<5){assert.equal((await q('select warpcore_mark_uncertain($1,$2,$3,$4) ok',params))[0].ok,true);const uri=`at://${account}/${j.record.$type}/${j.recordKey}`;assert.equal((await q('select warpcore_mark_published($1,$2,$3,$4,$5) ok',[...params,uri.replace(j.record.$type,'app.bsky.graph.follow')]))[0].ok,false);assert.equal((await q('select warpcore_mark_published($1,$2,$3,$4,$5) ok',[...params,uri]))[0].ok,true);}
 }
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>q('select warpcore_valid_repost_evidence($1)',[{}]),/permission/);await db.exec('reset role');}
 console.log('PASS: native repost exact SQL/JS parity, identity, migration preservation, role boundary and mixed five/hour budget');
}finally{await db.close();}
