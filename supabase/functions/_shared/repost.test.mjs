import test from 'node:test';import assert from 'node:assert/strict';
import {createReviewPacket,approveReview} from './curation.mjs';
import {prepareTransport} from './transport.mjs';
const author='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${author}/app.bsky.feed.post/3n256uxsaokol`,cid='bafyre'+'a'.repeat(53);
const story='a'.repeat(64),account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const evidence=[{id:'bsky1',url:'https://example.com/story',text:'Original author text',sourceType:'bluesky',visibility:'public',nativeUri:uri,nativeUrl:`https://bsky.app/profile/${author}/post/3n256uxsaokol`,sourceLinks:['https://example.com/story'],nativeCid:cid,nativeAuthorDid:author}];
const editorial={mode:'repost',change:'Meaningful model release',political:false,evidenceIds:['bsky1']};
test('native repost freezes attribution without copying text into own post',async()=>{
 const p=await createReviewPacket({storyKey:story,evidence,editorial});const d=await approveReview(p,{contentHash:p.contentHash,factsVerified:true,meaningfulChange:true,scopeApproved:true});
 const t=await prepareTransport(d,account,'2026-11-13T00:00:00.000Z');
 assert.deepEqual(t.record,{$type:'app.bsky.feed.repost',subject:{uri,cid},createdAt:'2026-11-13T00:00:00.000Z'});assert.equal(t.record.text,undefined);assert.equal(p.recordDraft.summary,undefined);
});
test('native repost rejects missing CID, wrong author, non-Bluesky, multiple evidence and unknown mode',async()=>{
 for(const patch of [{nativeCid:null},{nativeCid:'wrong'},{nativeAuthorDid:account},{sourceType:'rss'}])await assert.rejects(()=>createReviewPacket({storyKey:story,evidence:[{...evidence[0],...patch}],editorial}));
 await assert.rejects(()=>createReviewPacket({storyKey:story,evidence:[...evidence,{...evidence[0],id:'bsky2'}],editorial:{...editorial,evidenceIds:['bsky1','bsky2']}}));
 await assert.rejects(()=>createReviewPacket({storyKey:story,evidence,editorial:{...editorial,mode:'follow'}}));
});
test('Bluesky-origin evidence cannot silently become an original summary',async()=>{
 await assert.rejects(()=>createReviewPacket({storyKey:story,evidence,editorial:{...editorial,mode:'post',summary:'Paraphrased content',whyItMatters:'A detail'}}));
});
