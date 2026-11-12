import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite();
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(await fs.readFile(new URL('../docs/warpcore-schema-proposal.sql',import.meta.url),'utf8'));
 const key='e'.repeat(64);
 const old={uri:'legacy:1',story_key:key,source_type:'rss',source_id:'legacy',actor:'legacy',text:'Old',source_created_at:'2026-11-12',source_url:'https://example.com/old'};
 await db.query('select warpcore_ingest($1::jsonb)',[JSON.stringify([old])]);
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261112164434_warpcore_source_provenance.sql',import.meta.url),'utf8'));
 const legacy=(await db.query('select source_links,native_url from warpcore_candidates where uri=$1',[old.uri])).rows[0];
 assert.deepEqual(legacy.source_links,[old.source_url]);assert.equal(legacy.native_url,null);
 const item={...old,uri:'hn:123',source_type:'hn',source_links:['https://example.com/article','https://news.ycombinator.com/item?id=123'],native_uri:'123',native_url:'https://news.ycombinator.com/item?id=123'};
 await db.query('select warpcore_ingest($1::jsonb)',[JSON.stringify([item])]);
 await db.query('select warpcore_ingest($1::jsonb)',[JSON.stringify([item])]);
 const row=(await db.query('select source_links,native_uri,native_url from warpcore_candidates where uri=$1',[item.uri])).rows[0];
 assert.deepEqual(row.source_links,item.source_links);assert.equal(row.native_uri,item.native_uri);assert.equal(row.native_url,item.native_url);
 assert.equal((await db.query('select count(*)::int as n from warpcore_candidates')).rows[0].n,2);
 await db.exec('set role anon');await assert.rejects(()=>db.query('select source_links from public.warpcore_candidates'));await db.exec('reset role;set role authenticated');await assert.rejects(()=>db.query('select native_url from public.warpcore_candidates'));await db.exec('reset role');
 console.log('PASS: additive provenance migration, legacy backfill, HN native discussion, ingest replay, role denial');
}finally{await db.close();}
