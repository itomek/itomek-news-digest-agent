import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 for(const name of ['warpcore-schema-proposal.sql','warpcore-publication-ledger-proposal.sql','warpcore-operator-proposal.sql'])await db.exec(await fs.readFile(new URL('../docs/'+name,import.meta.url),'utf8'));
 const migration=new URL('../supabase/migrations/20261112190000_warpcore_publication_hour_guard.sql',import.meta.url);
 try{await db.exec(await fs.readFile(migration,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const account='did:plc:abcdefghijklmnopqrstuvwx',record=JSON.stringify({text:'synthetic',createdAt:'2026-11-12T12:00:00Z'});
 const args=n=>[account,String(n).repeat(64),'hash',record];
 for(const n of [1,2,3]){await db.query("insert into warpcore_stories(story_key,status) values ($1,'approved')",[args(n)[1]]);await db.query('select warpcore_prepare_publication($1,$2,$3,$4::jsonb,$5)',[...args(n),`story-${n}`]);await db.query('select warpcore_review_publication($1,$2,$3,$4::jsonb,true)',args(n));}
 const claim=n=>db.query('select * from warpcore_claim_publication($1,$2,$3,$4::jsonb)',args(n));
 assert.equal((await db.query('select * from warpcore_claim_publication($1,$2,$3,$4::jsonb)',[account,args(1)[1],'wrong',record])).rows.length,0);
 assert.equal((await claim(1)).rows.length,1);
 assert.equal((await claim(2)).rows.length,0,'different story in same account/hour must be denied');
 await db.query('select warpcore_mark_uncertain($1,$2,$3,$4::jsonb)',args(1));
 assert.equal((await claim(2)).rows.length,0,'uncertain attempt consumes hour');
 assert.equal((await db.query('select state from warpcore_publications where story_key=$1',[args(2)[1]])).rows[0].state,'prepared');
 await db.query('update warpcore_publication_slots set hour_slot=hour_slot-1');
 await db.query('select warpcore_mark_published($1,$2,$3,$4::jsonb,$5)',[...args(1),`at://${account}/app.bsky.feed.post/story-1`]);
 assert.equal((await claim(1)).rows.length,0,'published replay is never a claim');
 assert.equal((await claim(2)).rows.length,1,'published replay did not consume new hour');
 assert.equal((await claim(3)).rows.length,0);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(()=>claim(3));await assert.rejects(()=>db.query('select * from warpcore_publication_slots'));
  await db.exec('reset role');
 }
 assert.equal((await db.query("select has_function_privilege('service_role','public.warpcore_claim_publication(text,text,text,jsonb)','EXECUTE') as ok")).rows[0].ok,true);
 console.log('PASS: actual-send hourly limit, uncertainty consumption, replay/no-op slot preservation, role denial');
}finally{await db.close();}
