// SQL/JS TID parity and additive migration safety. Disposable embedded database only.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();const read=p=>fs.readFile(new URL(p,import.meta.url),'utf8');
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const p of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql'])await db.exec(await read('../supabase/migrations/'+p));
 const story='a'.repeat(64),account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
 await db.query("insert into warpcore_stories(story_key,status) values($1,'approved')",[story]);
 await db.query("insert into warpcore_publications(account_did,story_key,record_key,content_hash,state,record_payload) values($1,$2,$3,'old-hash','uncertain',$4)",[account,story,'story-'+story,{text:'Historical immutable record',createdAt:'2026-11-12T12:00:00.000Z'}]);
 await db.query('insert into warpcore_publication_slots(account_did,hour_slot) values($1,12345)',[account]);
 const slotsBefore=(await db.query('select row_to_json(s) as row from warpcore_publication_slots s')).rows;
 const before=(await db.query('select row_to_json(p) as row from warpcore_publications p')).rows;
 await db.exec(await read('../supabase/migrations/20261112192659_warpcore_tid_record_keys.sql'));
 assert.deepEqual((await db.query('select row_to_json(p) as row from warpcore_publications p')).rows,before,'Existing uncertain record must remain byte-for-byte unchanged');
 assert.deepEqual((await db.query('select row_to_json(s) as row from warpcore_publication_slots s')).rows,slotsBefore,'Consumed publication slot remains untouched');
 const tid=async(s,t)=>(await db.query('select warpcore_record_tid($1,$2) as tid',[s,t])).rows[0].tid;
 assert.equal(await tid('0'.repeat(64),'1970-01-01T00:00:00.000Z'),'2222222222222');
 assert.equal(await tid('f'.repeat(64),'1970-01-01T00:00:00.000Z'),'22222222222zz');
 assert.equal(await tid('0'.repeat(64),'1970-01-01T00:00:00.001Z'),'222222222zc22');
 assert.equal(await tid('f'.repeat(64),'1970-01-01T00:00:00.001Z'),'222222222zczz');
 assert.equal(await tid('a'.repeat(64),'2026-11-12T12:00:00Z'),'3n24gaky622pe');
 assert.equal(await tid('a44802c82c053c5d5044a1ca0ea8f60799b4878e97da25cb6ce9afd266e4c223','2026-11-12T19:20:54.330Z'),'3n256uxsaokol');
 const {deterministicTid:recordTid}=await import('../supabase/functions/_shared/publishing.mjs');
 for(const s of ['0'.repeat(64),'f'.repeat(64),'abc'+'1234567890abcdef'.repeat(4).slice(0,61)])for(const t of ['2026-11-12T18:30:05.123Z','2026-11-12T18:30:05.999Z'])assert.equal(await tid(s,t),recordTid(s,t));
 assert.equal(await tid(story,'2026-11-12T18:30:05.123999Z'),await tid(story,'2026-11-12T18:30:05.123Z'),'Submillisecond storage precision truncates like JS Date');
 await assert.rejects(()=>tid(story,'1969-12-31T23:59:59Z'));await assert.rejects(()=>tid(story,'2300-01-01T00:00:00Z'));await assert.rejects(()=>tid('invalid','2026-11-12T00:00:00Z'));
 await db.exec('set role anon');await assert.rejects(()=>tid(story,'2026-11-12T00:00:00Z'),/permission/);await db.exec('reset role;set role service_role');assert.match(await tid(story,'2026-11-12T00:00:00Z'),/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);await db.exec('reset role');
 console.log('PASS: SQL deterministic TID vectors, JS parity, precision/range guards, role boundary and preservation of uncertain rows');
}finally{await db.close();}
