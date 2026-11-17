import test from 'node:test';import assert from 'node:assert/strict';import {fetchNativeEvidence,nativeEvidenceIdentity,validateNativeCapture} from './native-verification.mjs';
const did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53);
const evidence={id:'native:original',sourceType:'bluesky',visibility:'public',nativeUri:uri,nativeCid:cid,nativeAuthorDid:did,url:'https://bsky.app/profile/'+did+'/post/3m3e4a2b22222',nativeUrl:'https://bsky.app/profile/'+did+'/post/3m3e4a2b22222'};
const data=()=>({posts:[{uri,cid,author:{did},record:{$type:'app.bsky.feed.post',text:'Official new capability is available.',createdAt:new Date().toISOString()},labels:[]}]});
test('native lookup derives a fixed unauthenticated endpoint and preserves raw capture identity',async()=>{
 let calls=0;const body=JSON.stringify(data());const source=await fetchNativeEvidence({evidence,fetcher:async(url,options)=>{calls++;assert.equal(url,'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(uri));assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'error');return new Response(body,{headers:{'content-type':'application/json'}});}});
 assert.equal(calls,1);assert.equal(source.body,body);assert.equal(source.url,evidence.nativeUrl);assert.equal(source.fetchedUrl,nativeEvidenceIdentity(evidence).fetchedUrl);assert.deepEqual(validateNativeCapture(source,evidence).subject,{uri,cid});assert.equal(source.factsVerified,undefined);
});
test('changed, missing, blocked, private, labelled, malformed or stale originals fail closed',async()=>{
 for(const mutate of [d=>d.posts=[],d=>d.posts.push(d.posts[0]),d=>d.posts[0].cid='bafyre'+'b'.repeat(53),d=>d.posts[0].uri=uri+'x',d=>d.posts[0].author.did='did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',d=>d.posts[0].labels=[{val:'warn'}],d=>d.posts[0].author.labels=[{val:'warn'}],d=>d.posts[0].viewer={blockedBy:true},d=>d.posts[0].private=true,d=>d.posts[0].record.$type='app.bsky.feed.repost',d=>d.posts[0].record.text='',d=>d.posts[0].record.createdAt='2000-01-01T00:00:00Z']){
  const d=data();mutate(d);await assert.rejects(()=>fetchNativeEvidence({evidence,fetcher:async()=>Response.json(d)}),/Native verification evidence rejected/);
 }
});
test('native identity cannot select arbitrary URLs, authorities or malformed subjects',()=>{
 for(const change of [{nativeUri:'at://evil.example/app.bsky.feed.post/3m3e4a2b22222'},{nativeAuthorDid:'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'},{nativeCid:'bad'},{nativeUrl:'http://bsky.app/'},{visibility:'private'},{sourceType:'rss'}])assert.throws(()=>nativeEvidenceIdentity({...evidence,...change}));
});
