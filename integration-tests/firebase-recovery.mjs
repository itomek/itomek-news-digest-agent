// One-time recovery artifact regression; isolated embedded Postgres, no network or publishing.
// Restore into integration-tests/firebase-recovery.mjs in the repository before running.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),story='a44802c82c053c5d5044a1ca0ea8f60799b4878e97da25cb6ce9afd266e4c223',account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',corrected='3n256uxsaokol';
const read=p=>fs.readFile(new URL(p,import.meta.url),'utf8');const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const row=async()=>(await q('select to_jsonb(p) r from warpcore_publications p'))[0].r;
const enabled=async()=>assert.equal((await q("select tgenabled from pg_trigger where tgname='warpcore_immutable_record'"))[0].tgenabled,'O');
const observations=()=>Object.fromEntries(['old','new'].map(kind=>[kind,{uri:`at://${account}/app.bsky.feed.post/${kind==='old'?'story-'+story:corrected}`,error:'RecordNotFound',checkedAt:new Date().toISOString(),pds:'https://verified-test-pds.example'}]));
let script;
const run=async(expected,proof=observations())=>{const quote=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'";const sql=script.replace(/^\\set.*$/mg,'').replace(":'expected_publication'",quote(expected)).replace(":'absence_observations'",quote(proof));try{await db.exec(sql);}catch(e){await db.exec('rollback');throw e;}};
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112193554_warpcore_firebase_tid_recovery.sql'])await db.exec(await read('../supabase/migrations/'+f));
 script=await read('../tools/recovery/firebase-tid-recovery.sql');
 await q("insert into warpcore_stories(story_key,status) values($1,'approved')",[story]);
 await q("insert into warpcore_publications(account_did,story_key,record_key,content_hash,state,approved_at,record_payload) values($1,$2,$3,'original-hash','uncertain',now(),$4)",[account,story,'story-'+story,{text:'Original public summary with source',createdAt:'2026-11-12T19:20:54.330Z'}]);
 await q('insert into warpcore_publication_slots(account_did,hour_slot) values($1,123456)',[account]);
 await q("insert into warpcore_curator_inbox(story_key,evidence_hash,evidence,editorial,attestations,dot_id,run_id,state) values($1,$2,'[]','{}','{}','test-dot','00000000-0000-4000-8000-000000000001','processed')",[story,'a'.repeat(64)]);
 const original=await row(),slots=await q('select to_jsonb(s) r from warpcore_publication_slots s'),inbox=await q('select to_jsonb(i) r from warpcore_curator_inbox i');
 await assert.rejects(()=>run({...original,content_hash:'wrong'}),/changed since/);await enabled();
 await assert.rejects(()=>run(original,{...observations(),new:{...observations().new,error:'UnknownError'}}),/observations/);await enabled();
 await assert.rejects(()=>run(original,{...observations(),old:{...observations().old,checkedAt:'2020-01-01T00:00:00Z'}}),/observations/);await enabled();
 await q("update warpcore_publications set state='published'");
 const published=await row();await assert.rejects(()=>run(published),/Ineligible/);await q("update warpcore_publications set state='uncertain'");
 // Force failure after the named immutable trigger has been disabled; rollback must restore it.
 await db.exec("create function test_recovery_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic update failure';end;$$;create trigger test_recovery_failure before update on warpcore_publications for each row execute function test_recovery_failure();");
 await assert.rejects(()=>run(original),/synthetic update failure/);await enabled();assert.deepEqual(await row(),original);assert.equal((await q('select count(*)::int n from warpcore_publication_recovery_audit'))[0].n,0);
 await db.exec('drop trigger test_recovery_failure on warpcore_publications;drop function test_recovery_failure();');
 await run(original);await enabled();assert.deepEqual(await row(),{...original,record_key:corrected,state:'prepared'});assert.deepEqual(await q('select to_jsonb(s) r from warpcore_publication_slots s'),slots);assert.deepEqual(await q('select to_jsonb(i) r from warpcore_curator_inbox i'),inbox);
 const audit=(await q('select * from warpcore_publication_recovery_audit'))[0];assert.deepEqual(audit.old_publication,original);assert.deepEqual(audit.prior_inbox,inbox.map(r=>r.r));assert.equal(audit.new_publication.record_key,corrected);
 await assert.rejects(()=>run(original),/changed since/);await assert.rejects(()=>q("update warpcore_publication_recovery_audit set operation=operation"),/append-only/);
 await db.exec('set role service_role');await assert.rejects(()=>q("update warpcore_publications set record_key='another-key'"),/immutable/i);await assert.rejects(()=>q('select * from warpcore_publication_recovery_audit'),/permission/);await db.exec('reset role');await enabled();
 console.log('PASS: guarded one-time recovery artifact, failed-transaction trigger restoration, exact audit, no payload/inbox/slot edits, published/mismatch refusal, service immutability retained');
}finally{await db.close();}
