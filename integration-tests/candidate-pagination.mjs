import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`create table warpcore_stories(story_key text primary key,status text,collected_at timestamptz);
create table warpcore_candidates(uri text,story_key text,source_type text,source_id text,source_created_at timestamptz,source_url text,text text,native_uri text,native_url text,source_links jsonb,collected_at timestamptz);
create table warpcore_curator_inbox(story_key text);
create table warpcore_publications(story_key text);
insert into warpcore_stories select lpad(n::text,64,'0'),'unverified_review_required','2026-11-13T10:00Z' from generate_series(1,307)n;
insert into warpcore_candidates select 'uri:'||story_key,story_key,'rss','one-busy-source','2026-11-13T09:00Z','https://example.com/'||story_key,'candidate',null,null,'[]','2026-11-13T10:00Z' from warpcore_stories;
insert into warpcore_curator_inbox values(lpad('303',64,'0'));
insert into warpcore_publications values(lpad('304',64,'0'));
update warpcore_stories set status='published' where story_key=lpad('305',64,'0');
update warpcore_candidates set source_created_at='2026-11-01T00:00Z' where story_key=lpad('306',64,'0');
update warpcore_candidates set source_created_at='2026-11-14T00:00Z' where story_key=lpad('307',64,'0');
insert into warpcore_candidates select 'newer:'||story_key,story_key,source_type,source_id,'2026-11-13T09:30Z',source_url,'newer candidate',native_uri,native_url,source_links,collected_at from warpcore_candidates where story_key=lpad('1',64,'0');`);
const sql=readFileSync(new URL('../docs/warpcore-candidate-page.sql',import.meta.url),'utf8');
const seen=[];let cursor=null;let pages=0;
while(true){
 const {rows}=await db.query(sql,['2026-11-13T11:00:00Z',cursor]);
 if(!rows.length)break;
 assert.ok(rows.length<=100);pages++;
 seen.push(...rows);cursor=rows.at(-1).story_key;
 if(pages===1){
  // Newly collected data does not shift subsequent pages or join the fixed scan.
  await db.exec(`insert into warpcore_stories values(lpad('308',64,'0'),'unverified_review_required','2026-11-13T11:01Z');
insert into warpcore_candidates select 'late',lpad('308',64,'0'),source_type,source_id,source_created_at,source_url,text,native_uri,native_url,source_links,'2026-11-13T11:01Z' from warpcore_candidates limit 1;`);
 }
 assert.ok(pages<10,'pagination terminates');
}
assert.equal(pages,4);assert.equal(seen.length,302);assert.equal(new Set(seen.map(x=>x.story_key)).size,302);
assert.equal(seen[0].excerpt,'newer candidate');
assert.equal(seen.at(-1).story_key,'302'.padStart(64,'0'));
console.log('PASS all 302 eligible same-source stories across four pages, deterministic newest evidence, no duplicates, fixed scan and exclusions');
await db.close();
