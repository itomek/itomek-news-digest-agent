import test from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from './pipeline.mjs';
test('empty source selection runs no adapters and never publishes', async()=>{
 assert.equal(typeof pipeline.runAdapters,'function');
 const result=await pipeline.runAdapters([],{});
 assert.deepEqual(result,{candidates:[],sources:[],publishing_enabled:false});
});
test('normalizes distinct adapter identities and retains public evidence',async()=>{
 const adapter={collect:async()=>[{id:'123',text:'Important release',url:'https://example.com/release',publishedAt:'2026-11-12T10:00:00Z',visibility:'public'}]};
 const result=await pipeline.runAdapters([{id:'a',adapter:'rss'},{id:'b',adapter:'hn'}],{rss:adapter,hn:adapter});
 assert.equal(result.candidates.length,2);
 assert.notEqual(result.candidates[0].uri,result.candidates[1].uri);
 assert.equal(result.candidates[0].source_type,'rss');
 assert.equal(result.candidates[0].status,'unverified_review_required');
});
test('rejects private or malformed evidence and isolates adapter failure',async()=>{
 const result=await pipeline.runAdapters([{id:'a',adapter:'newsletter'},{id:'b',adapter:'missing'}],{newsletter:{collect:async()=>[{id:'1',text:'private',visibility:'private'}]}});
 assert.equal(result.candidates.length,0);
 assert.deepEqual(result.sources.map(s=>s.status),['error','error']);
});
test('malformed source entry is reported without crashing',async()=>{const result=await pipeline.runAdapters([null],{});assert.equal(result.sources[0].status,'error');});
