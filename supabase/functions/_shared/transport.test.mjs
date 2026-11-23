import test from 'node:test';import assert from 'node:assert/strict';import * as t from './transport.mjs';
const draft={storyKey:'a'.repeat(64),summary:'Release adds useful capabilities.',whyItMatters:'Broader hardware availability.',links:['https://example.com/release'],verified:true,approved:true};
test('transport builds deterministic record but cannot send',async()=>{assert.equal(typeof t.prepareTransport,'function');const r=await t.prepareTransport(draft,'did:plc:abcdefghijklmnopqrstuvwx','2026-11-12T12:00:00Z');assert.equal(r.dryRun,true);assert.equal(r.request,null);assert.equal(r.record.$type,'app.bsky.feed.post');assert.equal(r.record.facets.length,1);});
test('rejects handle in place of pinned DID and invalid time',async()=>{await assert.rejects(()=>t.prepareTransport(draft,'warp-core.bsky.social','2026-11-12'));await assert.rejects(()=>t.prepareTransport(draft,'did:plc:abcdefghijklmnopqrstuvwx','invalid'));});
test('facets use UTF8 byte offsets after unicode text',async()=>{const r=await t.prepareTransport({...draft,summary:'新 release'},'did:plc:abcdefghijklmnopqrstuvwx','2026-11-12T12:00:00Z');const f=r.record.facets[0];assert.equal(new TextDecoder().decode(new TextEncoder().encode(r.record.text).slice(f.index.byteStart,f.index.byteEnd)),'https://example.com/release');});
test('normalized persisted createdAt is the sole timestamp used in post TID',async()=>{
 const r=await t.prepareTransport(draft,'did:plc:abcdefghijklmnopqrstuvwx','2026-11-12T12:00:00.000999Z');
 assert.equal(r.record.createdAt,'2026-11-12T12:00:00.000Z');assert.equal(r.recordKey,'3n24gaky622pe');
});
const captured={sourceType:'rss',visibility:'public',url:'https://example.com/launch',text:'新 release\nThis description must not appear.'};
const attestedLink={storyKey:draft.storyKey,mode:'source_link',evidence:captured,approved:true,verified:false};
test('source-link preview builds the ordinary Bluesky record without verified claims',async()=>{
 const account='did:plc:abcdefghijklmnopqrstuvwx',when='2026-11-12T12:00:00.000999Z';
 const record=await t.prepareTransport(attestedLink,account,when);
 assert.deepEqual(record,{dryRun:true,publishable:false,request:null,accountDid:account,recordKey:'3n24gaky622pe',contentHash:'c7917d934f13a8ecf39433fa3abd9f99ac1084de75fc8c4c41aba86266744d28',record:{
  $type:'app.bsky.feed.post',text:'Headline: 新 release\n\nhttps://example.com/launch',
  facets:[{index:{byteStart:23,byteEnd:49},features:[{$type:'app.bsky.richtext.facet#link',uri:captured.url}]}],createdAt:'2026-11-12T12:00:00.000Z'
 }});
});
test('source-link preparation rejects missing approval, verified label or supplied editorial prose',async()=>{
 for(const override of [{approved:false},{verified:true},{verified:undefined},{summary:'Unsupported claim'},{whyItMatters:'Unsupported claim'},{links:[captured.url]},{text:'Replacement headline'},{evidence:{...captured,visibility:'private'}}]){
  await assert.rejects(()=>t.prepareTransport({...attestedLink,...override},'did:plc:abcdefghijklmnopqrstuvwx','2026-11-12T12:00:00Z'),/source.link|publisher/i);
 }
});
