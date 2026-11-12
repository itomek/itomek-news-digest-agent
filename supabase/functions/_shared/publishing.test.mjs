import test from 'node:test';import assert from 'node:assert/strict';import * as p from './publishing.mjs';
const draft={storyKey:'a'.repeat(64),summary:'A meaningful release changes availability.',whyItMatters:'More hardware can run it.',links:['https://example.com/release'],verified:true,approved:true};
test('preview requires original summary, significance and verified links',()=>{assert.equal(typeof p.preview,'function');const r=p.preview(draft);assert.equal(r.publishable,false);assert.match(r.text,/More hardware/);assert.throws(()=>p.preview({...draft,verified:false}));});
test('stable key and changed-content detection prevent blind duplicate sends',async()=>{const a=await p.previewRecord(draft),b=await p.previewRecord({...draft,summary:'Changed summary'});assert.equal(a.recordKey,b.recordKey);assert.notEqual(a.contentHash,b.contentHash);});
test('uncertain outcome must reconcile, not retry',()=>{assert.equal(p.nextAction('uncertain',null),'reconcile');assert.equal(p.nextAction('published',null),'skip');assert.equal(p.nextAction('prepared',null),'await_authorization');assert.equal(p.nextAction('uncertain',{matches:true}),'mark_published');assert.equal(p.nextAction('uncertain',{matches:false}),'manual_review');});
test('dry run has no sender argument or network action and rejects unsafe links',async()=>{const r=await p.previewRecord(draft);assert.equal(r.mode,'dry_run');assert.equal(r.publishable,false);assert.throws(()=>p.preview({...draft,links:['javascript:alert(1)']}));});
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
