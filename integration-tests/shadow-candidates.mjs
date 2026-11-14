// Real embedded PostgreSQL discovery query; synthetic fixtures, no network or production DB.
import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {createCandidateSource} from '../supabase/functions/news-agent/candidate-source.mjs';
const db=new PGlite();
const stamp='2026-11-14T20:00:00Z',key=n=>n.toString(16).padStart(64,'0');
try{
 await db.exec(`create table warpcore_stories(story_key text primary key,status text,collected_at timestamptz);
 create table warpcore_candidates(uri text primary key,story_key text,source_type text,source_created_at timestamptz,source_url text,text text,collected_at timestamptz);
 create table warpcore_curator_inbox(story_key text,state text);
 create table warpcore_publications(story_key text,state text);`);
 await db.query(`insert into warpcore_stories select lpad(to_hex(n),64,'0'),'unverified_review_required',$1::timestamptz from generate_series(1,220) n`,[stamp]);
 await db.query(`insert into warpcore_candidates select 'uri-'||n,lpad(to_hex(n),64,'0'),'rss',$1::timestamptz,'https://example.com/'||n,'Discovery '||n,$1::timestamptz from generate_series(1,220) n`,[stamp]);
 // 206–214 are excluded independently by every boundary in the contract.
 await db.query(`update warpcore_stories set status='published' where story_key=$1`,[key(206)]);
 await db.query(`update warpcore_stories set collected_at=$1::timestamptz+interval '1 microsecond' where story_key=$2`,[stamp,key(207)]);
 await db.query(`update warpcore_candidates set collected_at=$1::timestamptz+interval '1 microsecond' where story_key=$2`,[stamp,key(208)]);
 await db.query(`update warpcore_candidates set source_created_at=$1::timestamptz-interval '7 days 1 microsecond' where story_key=$2`,[stamp,key(209)]);
 await db.query(`update warpcore_candidates set source_created_at=$1::timestamptz+interval '5 minutes 1 microsecond' where story_key=$2`,[stamp,key(210)]);
 await db.query(`insert into warpcore_curator_inbox values ($1,'pending'),($2,'rejected')`,[key(211),key(212)]);
 await db.query(`insert into warpcore_publications values ($1,'published'),($2,'uncertain')`,[key(213),key(214)]);
 await db.query(`update warpcore_candidates set source_created_at=$1::timestamptz-interval '7 days' where story_key=$2`,[stamp,key(215)]);
 await db.query(`update warpcore_candidates set source_created_at=$1::timestamptz+interval '5 minutes' where story_key=$2`,[stamp,key(216)]);
 // Same story: newest eligible candidate and deterministic URI tie break, not a new story.
 await db.query(`insert into warpcore_candidates values
 ('a-new',$2,'bluesky',$1::timestamptz+interval '1 minute','https://example.com/new','Newest selected',$1),
 ('b-new',$2,'rss',$1::timestamptz+interval '1 minute','https://example.com/tie','Tie loser',$1),
 ('future-collected',$2,'rss',$1::timestamptz+interval '2 minutes','https://example.com/future','Ineligible newest',$1::timestamptz+interval '1 second')`,[stamp,key(1)]);
 let calls=0;const fetch=createCandidateSource({query:async(sql,params)=>{calls++;assert.deepEqual(params[0],stamp);return db.query(sql,params);}});
 const all=[],sizes=[];let cursor=null;
 for(;;){const page=await fetch({scanStartedAt:stamp,cursor});sizes.push(page.length);if(!page.length)break;all.push(...page);cursor=page.at(-1).id;}
 assert.deepEqual(sizes,[100,100,11,0]);assert.equal(calls,4);
 assert.deepEqual(all.map(c=>c.id),Array.from({length:220},(_,i)=>i+1).filter(i=>i<206||i>214).map(key));
 assert.equal(all[0].discoveryText,'Newest selected');assert.equal(all[0].sourceType,'bluesky');
 assert.equal(all.find(c=>c.id===key(215)).sourceCreatedAt,'2026-11-07T20:00:00.000Z');
 assert.equal(all.find(c=>c.id===key(216)).sourceCreatedAt,'2026-11-14T20:05:00.000Z');
 // Exclusions remain live between pages; fixed timestamp is not repeatable-read.
 await db.query(`insert into warpcore_curator_inbox values ($1,'processed')`,[key(101)]);
 const next=await fetch({scanStartedAt:stamp,cursor:key(100)});
 assert.equal(next[0].id,key(102));assert.equal(next.length,100);
 console.log('PASS: embedded PostgreSQL candidate scan, 211 eligible across all pages, newest/tie-break, cutoffs, live dedup and no review quota');
}finally{await db.close();}
