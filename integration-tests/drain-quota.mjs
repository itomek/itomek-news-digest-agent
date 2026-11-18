import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),account='did:plc:abcdefghijklmnopqrstuvwx',record={text:'Synthetic',createdAt:'2026-11-18T00:00:00Z'};
const q=async(s,a=[])=>(await db.query(s,a)).rows,key=n=>n.toString(16).padStart(64,'0'),args=n=>[account,key(n),'hash',record],claim=n=>q('select * from warpcore_claim_publication($1,$2,$3,$4)',args(n));
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['20261112145946_warpcore_review_base.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112201145_warpcore_hourly_batch_budget.sql','20261112153023_warpcore_login_guard.sql','20261117162306_warpcore_login_batch_budget.sql','20261118180116_warpcore_drain_without_hourly_quota.sql'])await db.exec(await fs.readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
 for(let n=1;n<=12;n++){
  await q("insert into warpcore_stories(story_key,status) values($1,'approved')",[key(n)]);await q('select warpcore_prepare_publication($1,$2,$3,$4,$5)',[...args(n),'fixture-'+n]);
  if(n<12)await q('select warpcore_review_publication($1,$2,$3,$4,true)',args(n));
 }
 for(let n=1;n<=11;n++){assert.equal((await q('select warpcore_reserve_login($1) accepted',[account]))[0].accepted,true);assert.equal((await claim(n)).length,1);}
 assert.equal((await q('select attempts from warpcore_publication_slots'))[0].attempts,11);
 assert.equal((await claim(1)).length,0,'sending record never replayed');assert.equal((await claim(12)).length,0,'unapproved record never sent');
 await q('select warpcore_mark_uncertain($1,$2,$3,$4)',args(1));assert.equal((await claim(1)).length,0,'uncertain send never replayed');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>claim(12),/permission/);await db.exec('reset role');}
 console.log('PASS >5 same-hour claims/logins without resetting accounting; immutable approval and uncertainty/replay/private-access protections remain');
}finally{await db.close();}
