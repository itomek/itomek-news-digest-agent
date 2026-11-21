import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const p of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261115204734_warpcore_source_sync_checkpoints.sql'])await db.exec(await fs.readFile(new URL('../supabase/migrations/'+p,import.meta.url),'utf8'));
 // Install only after asserting the new contract is missing in the legacy schema.
 await db.exec(await fs.readFile(new URL('../supabase/functions/news-agent/sql/source-health.sql',import.meta.url),'utf8'));
 const q=async(s,a=[])=>(await db.query(s,a)).rows;
 const begin=async(key='rss:feed',hash='a'.repeat(64))=>(await q('select public.warpcore_sync_begin($1,$2,$3,$4,now()-interval \'7 days\',now()) r',[key,'rss','feed',hash]))[0].r;
 const finish=async(s,outcome='partial',cursor={page:1},head=null,reasons=[])=>(await q('select public.warpcore_sync_finish($1,$2,\'[]\', $3,$4,null,null,0,$5,$6) r',[s.source_key,s.token,outcome,cursor==null?null:JSON.stringify(cursor),head,reasons]))[0].r;
 let s=await begin();await finish(s,'partial',{page:1},new Date().toISOString(),['finite_feed_history']);
 let row=(await q('select * from public.warpcore_source_sync'))[0];assert.ok(row.head_checked_at);assert.ok(row.last_accepted_at);assert.ok(row.progressed_at);assert.equal(row.covered_through,null);assert.equal(row.last_success_at,null);assert.deepEqual(row.coverage_reasons,['finite_feed_history']);
 const progress=row.progressed_at.toISOString();s=await begin();await finish(s,'partial',{page:1});row=(await q('select * from public.warpcore_source_sync'))[0];assert.equal(row.progressed_at.toISOString(),progress,'Repeated cursor and no new evidence is not progress');
 s=await begin();await finish(s,'partial',{page:2});row=(await q('select * from public.warpcore_source_sync'))[0];assert.ok(row.progressed_at>=new Date(progress));
 s=await begin();await assert.rejects(()=>finish(s,'partial',{page:3},null,['private provider body']),/invalid source observation/);await finish(s,'failed',null);
 assert.equal((await q('select count(*)::int n from public.warpcore_configured_source_health'))[0].n,0,'Historical checkpoint does not create trusted roster membership');
 await q('insert into public.warpcore_source_roster(source_key,config_hash) values($1,$2)',['rss:feed','a'.repeat(64)]);
 assert.equal((await q('select count(*)::int n from public.warpcore_configured_source_health'))[0].n,1);
 s=await begin('rss:feed','b'.repeat(64));await finish(s,'empty',null);row=(await q('select * from public.warpcore_configured_source_health'))[0];assert.equal(row.head_checked_at,null,'Old configuration cannot establish new freshness');assert.equal(row.configuration_matches,false);
 await db.exec('set role service_role');s=await begin('service');await finish(s,'empty',null,new Date().toISOString());s=await begin('legacy');await q("select public.warpcore_sync_finish($1,$2,'[]','empty',null,null,null,0)",[s.source_key,s.token]);await assert.rejects(()=>q("insert into public.warpcore_source_roster(source_key,config_hash) values('bad',repeat('c',64))"),/permission/);await db.exec('reset role');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>q('select * from public.warpcore_source_roster'),/permission/);await assert.rejects(()=>begin(),/permission/);await db.exec('reset role');}
 console.log('PASS: typed durable observations, semantic cursor progress, trusted generation roster and private grants');
}finally{await db.close();}
