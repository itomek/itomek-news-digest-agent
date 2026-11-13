import test from 'node:test';
import assert from 'node:assert/strict';
import {collect,validateConfig} from './core.mjs';
const config={actors:['example.bsky.social'],terms:['AMD']};
const now=Date.parse('2026-11-12T14:00:00Z');
const entry={post:{uri:'at://did:plc:example/app.bsky.feed.post/1',record:{text:'AMD news',createdAt:new Date(now-1000).toISOString()}}};
const response=(feed)=>new Response(JSON.stringify({feed}));
test('configuration must be nonempty and cannot accept URLs',()=>{assert.throws(()=>validateConfig({}));assert.throws(()=>validateConfig({...config,actors:['https://evil.test']}));});
test('deduplicates and marks every item unverified',async()=>{const result=await collect(config,async(u,o)=>{assert.equal(u.hostname,'public.api.bsky.app');assert.equal(o.redirect,'error');return response([entry,entry]);},now);assert.equal(result.candidates.length,1);assert.equal(result.publishing_enabled,false);assert.equal(result.candidates[0].status,'unverified_review_required');});
test('omits replies/reposts/old/future/unmatched',async()=>{const withRecord=(r)=>({post:{...entry.post,record:{...entry.post.record,...r}}});const result=await collect(config,async()=>response([{...entry,reason:{}},withRecord({reply:{}}),withRecord({createdAt:'2000-01-01'}),withRecord({createdAt:'2099-01-01'}),withRecord({text:'sports'})]),now);assert.equal(result.candidates.length,0);});
test('source failure is distinct from empty',async()=>{const fail=await collect(config,async()=>new Response('',{status:500}),now);assert.equal(fail.sources[0].status,'error');const empty=await collect(config,async()=>response([]),now);assert.equal(empty.sources[0].status,'ok');});
test('caps body size',async()=>{const result=await collect(config,async()=>new Response('x'.repeat(1000001)),now);assert.equal(result.sources[0].status,'error');});
test('uses link-card titles for sources with empty text',async()=>{const card={post:{...entry.post,record:{...entry.post.record,text:'',embed:{external:{uri:'https://example.com/a',title:'AMD launches chip',description:'New architecture'}}}}};const result=await collect(config,async()=>response([card]),now);assert.equal(result.candidates.length,1);assert.match(result.candidates[0].text,/AMD launches/);assert.deepEqual(result.candidates[0].links,['https://example.com/a']);});
test('pinned actor captures immutable repost identity and rejects spoofed author',async()=>{
 const did='did:plc:abcdefghijklmnopqrstuvwx',cid='bafyre'+'a'.repeat(53),uri=`at://${did}/app.bsky.feed.post/3n256uxsaokol`;
 const pinned={...config,actorDids:{'example.bsky.social':did}};
 const good={post:{...entry.post,uri,cid,author:{did}}};
 const result=await collect(pinned,async()=>response([good,{post:{...good.post,author:{did:'did:plc:wrong'}}}]),now);
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].native_cid,cid);assert.equal(result.candidates[0].native_author_did,did);
});
test('pinned standalone collector candidates remain persistable with exact native identity',async()=>{
 const {candidateRow}=await import('./store.mjs');const did='did:plc:abcdefghijklmnopqrstuvwx',cid='bafyre'+'a'.repeat(53),uri=`at://${did}/app.bsky.feed.post/3n256uxsaokol`;
 const result=await collect({...config,actorDids:{'example.bsky.social':did}},async()=>response([{post:{...entry.post,uri,cid,author:{did}}}]),now);
 const row=await candidateRow(result.candidates[0]);assert.equal(row.native_cid,cid);assert.equal(row.native_uri,uri);
});
