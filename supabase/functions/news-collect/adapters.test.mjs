import test from 'node:test';import assert from 'node:assert/strict';import * as a from './adapters.mjs';
const uri='at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/abc';
const candidate={uri,actor:'example.com',text:'Release news',created_at:'2026-11-12',links:['https://example.com/article']};
const config={actors:['example.com'],terms:['release']};
test('Bluesky adapter retains author post attribution even with external article',async()=>{
 assert.equal(typeof a.createBlueskyAdapter,'function');
 const adapter=a.createBlueskyAdapter(async()=>({sources:[{status:'ok'}],candidates:[candidate]}));
 const [item]=await adapter.collect(config);
 assert.equal(item.nativeUri,uri);assert.equal(item.nativeUrl,'https://bsky.app/profile/did%3Aplc%3Aabcdefghijklmnopqrstuvwx/post/abc');assert.equal(item.url,candidate.links[0]);
});
test('native post is fallback when external links are unsafe or absent',async()=>{
 const adapter=a.createBlueskyAdapter(async()=>({sources:[{status:'ok'}],candidates:[{...candidate,links:['https://user:pass@example.com','javascript:alert(1)']}]}));
 const [item]=await adapter.collect(config);assert.equal(item.url,item.nativeUrl);
});
test('malformed AT post identifier is not fabricated into provenance URL',async()=>{
 const adapter=a.createBlueskyAdapter(async()=>({sources:[{status:'ok'}],candidates:[{...candidate,uri:'at://bad'}]}));
 await assert.rejects(()=>adapter.collect(config));
});
