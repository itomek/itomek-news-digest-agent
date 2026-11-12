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
test('retains native provenance alongside article link without changing primary dedup link',async()=>{
 const nativeUri='at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/abc';
 const nativeUrl='https://bsky.app/profile/did%3Aplc%3Aabcdefghijklmnopqrstuvwx/post/abc';
 const result=await pipeline.runAdapters([{id:'source',adapter:'bluesky'}],{bluesky:{collect:async()=>[{id:nativeUri,nativeUri,nativeUrl,text:'News',url:'https://example.com/story',publishedAt:'2026-11-12',visibility:'public'}]}});
 assert.equal(result.candidates[0].native_uri,nativeUri);assert.equal(result.candidates[0].native_url,nativeUrl);
 assert.deepEqual(result.candidates[0].links,['https://example.com/story',nativeUrl]);
});
test('rejects unsafe native provenance URLs',async()=>{
 const result=await pipeline.runAdapters([{id:'source',adapter:'fixture'}],{fixture:{collect:async()=>[{id:'1',nativeUrl:'javascript:alert(1)',text:'News',url:'https://example.com/story',publishedAt:'2026-11-12',visibility:'public'}]}});
 assert.equal(result.candidates.length,0);assert.equal(result.sources[0].status,'error');
});
