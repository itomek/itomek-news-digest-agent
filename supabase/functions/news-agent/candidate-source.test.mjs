import test from 'node:test';
import assert from 'node:assert/strict';
import {createCandidateSource} from './candidate-source.mjs';
const stamp='2026-11-14T20:00:00Z';
const key=n=>n.toString(16).padStart(64,'0');
const row=n=>({story_key:key(n),source_url:'https://example.com/'+n,source_type:'rss',source_created_at:stamp,excerpt:'Discovery '+n});
test('parameterized fixed timestamp/cursor read and explicit untrusted projection',async()=>{
 const fetch=createCandidateSource({query:async(sql,params)=>{assert.deepEqual(params,[stamp,key(1)]);assert.match(sql,/limit 100/i);assert.ok(!sql.includes(stamp));return {rows:[{...row(2),privateField:'excluded'}]};}});
 assert.deepEqual(await fetch({scanStartedAt:stamp,cursor:key(1)}),[{id:key(2),sourceUrl:'https://example.com/2',sourceType:'rss',sourceCreatedAt:stamp,discoveryText:'Discovery 2'}]);
});
test('invalid UTC timestamps and cursors fail before database access',async()=>{
 let calls=0;const fetch=createCandidateSource({query:async()=>{calls++;return {rows:[]};}});
 for(const scanStartedAt of ['2026-02-30T20:00:00Z','2026-11-14','2026-11-14T20:00:00+00:00','2026-11-14T25:00:00Z',null,123])await assert.rejects(fetch({scanStartedAt}),/timestamp/i);
 for(const cursor of ['',key(1).toUpperCase().replace(/1$/,'A'),"';delete",1])await assert.rejects(fetch({scanStartedAt:stamp,cursor}),/cursor/i);
 assert.equal(calls,0);
});
test('fail closed on malformed, unordered, duplicate, stale or oversized pages',async()=>{
 const malformed=[null,{rows:null},{rows:[null]},{rows:Array.from({length:101},(_,i)=>row(i+1))},{rows:[row(2),row(1)]},{rows:[row(1),row(1)]}];
 for(const patch of [{story_key:'x'},{source_url:'http://example.com'},{source_url:'https://u:p@example.com'},{source_url:5},{source_type:''},{excerpt:''},{source_created_at:'bad'},{source_created_at:'2026-11-01T00:00:00Z'}])malformed.push({rows:[{...row(1),...patch}]});
 for(const result of malformed)await assert.rejects(createCandidateSource({query:async()=>result})({scanStartedAt:stamp}),/candidate/i);
 await assert.rejects(createCandidateSource({query:async()=>({rows:[row(1)]})})({scanStartedAt:stamp,cursor:key(1)}),/candidate/i);
});
