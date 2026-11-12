import test from 'node:test';import assert from 'node:assert/strict';import * as p from './publishing.mjs';
const draft={storyKey:'a'.repeat(64),summary:'A meaningful release changes availability.',whyItMatters:'More hardware can run it.',links:['https://example.com/release'],verified:true,approved:true};
test('preview requires original summary, significance and verified links',()=>{assert.equal(typeof p.preview,'function');const r=p.preview(draft);assert.equal(r.publishable,false);assert.match(r.text,/More hardware/);assert.throws(()=>p.preview({...draft,verified:false}));});
test('stable key and changed-content detection prevent blind duplicate sends',async()=>{const a=await p.previewRecord(draft,'2026-11-12T12:00:00Z'),b=await p.previewRecord({...draft,summary:'Changed summary'},'2026-11-12T12:00:00Z');assert.equal(a.recordKey,b.recordKey);assert.notEqual(a.contentHash,b.contentHash);});
test('uncertain outcome must reconcile, not retry',()=>{assert.equal(p.nextAction('uncertain',null),'reconcile');assert.equal(p.nextAction('published',null),'skip');assert.equal(p.nextAction('prepared',null),'await_authorization');assert.equal(p.nextAction('uncertain',{matches:true}),'mark_published');assert.equal(p.nextAction('uncertain',{matches:false}),'manual_review');});
test('dry run has no sender argument or network action and rejects unsafe links',async()=>{const r=await p.previewRecord(draft,'2026-11-12T12:00:00Z');assert.equal(r.mode,'dry_run');assert.equal(r.publishable,false);assert.throws(()=>p.preview({...draft,links:['javascript:alert(1)']}));});
test('article and native-source attribution are clickable native facets with Unicode prose',async()=>{
 const {prepareTransport}=await import('./transport.mjs');
 const links=['https://example.com/release','https://bsky.app/profile/example.com/post/abc'];
 const r=await prepareTransport({...draft,summary:'新 release',whyItMatters:'Broader access.',links},'did:plc:abcdefghijklmnopqrstuvwx','2026-11-12T12:00:00Z');
 assert.equal(r.record.facets.length,2);
 const bytes=new TextEncoder().encode(r.record.text);
 for(let i=0;i<links.length;i++){
  const f=r.record.facets[i];assert.equal(f.features[0].$type,'app.bsky.richtext.facet#link');assert.equal(f.features[0].uri,links[i]);
  assert.equal(new TextDecoder().decode(bytes.slice(f.index.byteStart,f.index.byteEnd)),links[i]);
 }
 assert.equal(r.publishable,false);
});
// Official spec https://atproto.com/specs/tid
// Official post lexicon: at://did:plc:4v4y5r3lwsbtmsxhile2ljac/com.atproto.lexicon.schema/app.bsky.feed.post
// Verified CID bafyreia7rgxu7467phwpcgzaw62l5bzmxufkpikrc5zm4q3xhjmuhq4pti declares key:"tid".
// Current official validator: https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/repo/prepare.ts
// Fixtures independently calculated with integer Python and mirrored in SQL tests.
test('deterministic post TID uses persisted timestamp and first ten story bits',()=>{
 assert.equal(typeof p.deterministicTid,'function');
 assert.equal(p.deterministicTid('a'.repeat(64),'2026-11-12T12:00:00Z'),'3n24gaky622pe');
 assert.equal(p.deterministicTid('0'.repeat(64),'1970-01-01T00:00:00Z'),'2222222222222');
 assert.equal(p.deterministicTid('f'.repeat(64),'1970-01-01T00:00:00Z'),'22222222222zz');
 assert.equal(p.deterministicTid('a'.repeat(64),'2026-11-12T12:00:00.000999Z'),'3n24gaky622pe');
 assert.match(p.deterministicTid('a'.repeat(64),'2026-11-12T12:00:00Z'),/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
});
test('TID rejects invalid hash, missing time, preepoch and overflow',()=>{
 for(const [key,time] of [['bad','2026-11-12'],['a'.repeat(64),undefined],['a'.repeat(64),'invalid'],['a'.repeat(64),'1969-12-31T23:59:59.999Z'],['a'.repeat(64),new Date(9007199254741).toISOString()]])assert.throws(()=>p.deterministicTid(key,time));
});
test('Firebase persisted fixture matches independent Python and SQL expected TID',()=>{
 assert.equal(p.deterministicTid('a44802c82c053c5d5044a1ca0ea8f60799b4878e97da25cb6ce9afd266e4c223','2026-11-12T19:20:54.330Z'),'3n256uxsaokol');
});
