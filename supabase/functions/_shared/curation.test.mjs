import test from 'node:test';import assert from 'node:assert/strict';import * as c from './curation.mjs';
const input={storyKey:'a'.repeat(64),evidence:[{id:'source-a',url:'https://example.com/release',text:'Release raw material',sourceType:'rss',visibility:'public'}],editorial:{summary:'A release expands access.',whyItMatters:'More developers can use it.',change:'New availability',evidenceIds:['source-a'],political:false}};
test('builds source-neutral review packet without approving or calling a model',async()=>{assert.equal(typeof c.createReviewPacket,'function');const p=await c.createReviewPacket(input);assert.equal(p.status,'awaiting_review');assert.equal(p.approved,false);assert.equal(p.evidence[0].sourceType,'rss');assert.equal(p.recordDraft.links[0],'https://example.com/release');});
test('rejects invented citations and political items pending explicit scope',async()=>{await assert.rejects(()=>c.createReviewPacket({...input,editorial:{...input.editorial,evidenceIds:['invented']}}));await assert.rejects(()=>c.createReviewPacket({...input,editorial:{...input.editorial,political:true}}));});
test('review binds exact content and requires verification attestations',async()=>{const p=await c.createReviewPacket(input);await assert.rejects(()=>c.approveReview(p,{contentHash:'wrong',factsVerified:true,meaningfulChange:true,scopeApproved:true}));const d=await c.approveReview(p,{contentHash:p.contentHash,factsVerified:true,meaningfulChange:true,scopeApproved:true});assert.equal(d.approved,true);assert.equal(d.verified,true);});
test('raw repost and unsupported significance do not pass preparation',async()=>{await assert.rejects(()=>c.createReviewPacket({...input,editorial:{...input.editorial,summary:'Release raw material'}}));await assert.rejects(()=>c.createReviewPacket({...input,editorial:{...input.editorial,change:''}}));});
test('changed packet cannot reuse approval hash',async()=>{const p=await c.createReviewPacket(input);p.recordDraft.summary='Changed';await assert.rejects(()=>c.approveReview(p,{contentHash:p.contentHash,factsVerified:true,meaningfulChange:true,scopeApproved:true}));});
test('rejects private evidence and missing typed provenance',async()=>{await assert.rejects(()=>c.createReviewPacket({...input,evidence:[{...input.evidence[0],visibility:'private'}]}));await assert.rejects(()=>c.createReviewPacket({...input,evidence:[{...input.evidence[0],id:undefined}],editorial:{...input.editorial,evidenceIds:[undefined]}}));});
test('JSONB key reordering preserves exact review hash',async()=>{const p=await c.createReviewPacket(input);const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().reverse().map(k=>[k,reorder(v[k])])):v;const restored=reorder(p);assert.equal((await c.approveReview(restored,{contentHash:p.contentHash,factsVerified:true,meaningfulChange:true,scopeApproved:true})).approved,true);});
test('review binds native source provenance and includes clickable attribution links',async()=>{
 const native='https://bsky.app/profile/example.com/post/abc';
 const p=await c.createReviewPacket({...input,evidence:[{...input.evidence[0],nativeUri:'at://example.com/app.bsky.feed.post/abc',nativeUrl:native,sourceLinks:['https://example.com/release',native]}]});
 assert.equal(p.evidence[0].nativeUrl,native);assert.equal(p.evidence[0].nativeUri,'at://example.com/app.bsky.feed.post/abc');
 assert.deepEqual(p.recordDraft.links,['https://example.com/release',native]);
 p.evidence[0].nativeUrl='https://example.com/changed';await assert.rejects(()=>c.approveReview(p,{contentHash:p.contentHash,factsVerified:true,meaningfulChange:true,scopeApproved:true}));
});
test('invalid provenance URLs are rejected rather than included in review',async()=>{
 await assert.rejects(()=>c.createReviewPacket({...input,evidence:[{...input.evidence[0],nativeUrl:'javascript:alert(1)'}]}));
});
test('too many attribution links fail rather than silently dropping sources',async()=>{
 await assert.rejects(()=>c.createReviewPacket({...input,evidence:[{...input.evidence[0],sourceLinks:['https://example.com/one','https://example.com/two','https://example.com/three','https://example.com/four']}]}));
});
