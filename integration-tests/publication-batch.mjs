import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),account='did:plc:abcdefghijklmnopqrstuvwx',record={text:'Synthetic test publication',createdAt:'2026-11-12T12:00:00.000Z'};
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;const args=n=>[account,n.toString(16).padStart(64,'0'),'hash',record];const claim=n=>q('select * from warpcore_claim_publication($1,$2,$3,$4)',args(n));
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['20261112145946_warpcore_review_base.sql','20261112190000_warpcore_publication_hour_guard.sql'])await db.exec(await fs.readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 for(let n=1;n<=8;n++){await q("insert into warpcore_stories(story_key,status) values($1,'approved')",[args(n)[1]]);await q('select warpcore_prepare_publication($1,$2,$3,$4,$5)',[...args(n),'test-'+n]);if(n!==8)await q('select warpcore_review_publication($1,$2,$3,$4,true)',args(n));}
 assert.equal((await claim(1)).length,1);await q('select warpcore_mark_uncertain($1,$2,$3,$4)',args(1));await q('select warpcore_mark_published($1,$2,$3,$4,$5)',[...args(1),`at://${account}/app.bsky.feed.post/test-1`]);
 const first=(await q('select to_jsonb(p) r from warpcore_publications p where story_key=$1',[args(1)[1]]))[0].r;const slot=(await q('select to_jsonb(s) r from warpcore_publication_slots s'))[0].r;
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261112201145_warpcore_hourly_batch_budget.sql',import.meta.url),'utf8'));
 assert.deepEqual((await q('select to_jsonb(p) r from warpcore_publications p where story_key=$1',[args(1)[1]]))[0].r,first,'Published record unchanged');
 assert.deepEqual((await q('select to_jsonb(s) r from warpcore_publication_slots s'))[0].r,{...slot,attempts:1},'Existing consumed slot remains one attempt; timestamp/hour untouched');
 assert.equal((await claim(1)).length,0);assert.equal((await claim(8)).length,0,'No approval cannot spend budget');assert.equal((await q('select * from warpcore_claim_publication($1,$2,$3,$4)',[account,args(2)[1],'wrong',record])).length,0);
 for(let n=2;n<=5;n++)assert.equal((await claim(n)).length,1);
 await q('select warpcore_mark_uncertain($1,$2,$3,$4)',args(2));assert.equal((await claim(2)).length,0);assert.equal((await claim(6)).length,0);assert.equal((await q('select attempts from warpcore_publication_slots'))[0].attempts,5);
 assert.equal((await q('select state from warpcore_publications where story_key=$1',[args(6)[1]]))[0].state,'prepared');
 // Only the isolated fixture advances its saved hour, never production slots.
 await q('update warpcore_publication_slots set hour_slot=hour_slot-1');assert.equal((await claim(2)).length,0,'Uncertain old claim is never retried');assert.equal((await claim(6)).length,1);assert.equal((await q('select attempts from warpcore_publication_slots'))[0].attempts,1,'New hour starts at one');
 await q('update warpcore_publication_slots set hour_slot=hour_slot+1');assert.equal((await claim(7)).length,0,'Clock regression cannot reset budget');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>claim(7),/permission/);await db.exec('reset role');}
 console.log('PASS: five attempts/hour, preserved consumed slot and published record, exact approval before budget, uncertainty/replay rules, next-hour reset, clock-regression refusal');
}finally{await db.close();}
