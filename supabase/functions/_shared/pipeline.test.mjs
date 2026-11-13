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

test("rejects multiple expensive HN selections before adapter calls",async()=>{let calls=0;await assert.rejects(()=>pipeline.runAdapters([{id:"a",adapter:"hn"},{id:"b",adapter:"hn"}],{hn:{collect:async()=>{calls++;return [];}}}));assert.equal(calls,0);});

test('expanded roster collects at most four sources concurrently in deterministic order',async()=>{
 let active=0,peak=0;
 const selections=Array.from({length:24},(_,i)=>({id:`source_${i}`,adapter:'rss'}));
 const result=await pipeline.runAdapters(selections,{rss:{collect:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return [];}}});
 assert.equal(peak,4);assert.deepEqual(result.sources.map(s=>s.id),selections.map(s=>s.id));
});
test('rejects rosters above bounded expanded maximum',async()=>{
 await assert.rejects(()=>pipeline.runAdapters(Array.from({length:41},(_,i)=>({id:`s${i}`,adapter:'rss'})),{}));
});
test('starts slow HN first without changing reported roster order',async()=>{
 const started=[];const selections=[{id:'a',adapter:'rss'},{id:'b',adapter:'rss'},{id:'h',adapter:'hn'}];
 const make=kind=>({collect:async()=>{started.push(kind);await new Promise(r=>setTimeout(r,1));return [];}});
 const result=await pipeline.runAdapters(selections,{rss:make('rss'),hn:make('hn')});
 assert.equal(started[0],'hn');assert.deepEqual(result.sources.map(x=>x.id),['a','b','h']);
});

test('exactly forty sources remain within the bounded discovery capacity',async()=>{
 const selections=Array.from({length:40},(_,i)=>({id:`s${i}`,adapter:'rss'}));
 const result=await pipeline.runAdapters(selections,{rss:{collect:async()=>[]}});
 assert.equal(result.sources.length,40);assert.ok(result.sources.every(s=>s.status==='ok'));
});
