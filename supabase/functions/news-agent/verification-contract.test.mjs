import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVerificationRequest,validateVerificationResult} from './verification-contract.mjs';
const sha='a'.repeat(64),now='2026-11-16T20:00:00.000Z';
const body='Released 2026-11-16. A new local inference engine supports offline execution.';
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
async function fixture(){
 const source={evidenceId:'e1',url:'https://example.com/release',contentSha256:await digest(body),fetchedAt:now,body};
 const editorial={political:false,summary:'A local inference engine was released.',whyItMatters:'It supports offline execution.',change:'New engine release.',evidenceIds:['e1']};
 const claims=[editorial.summary,editorial.whyItMatters,editorial.change,'2026-11-16'].map(claim=>({claim,evidenceId:'e1',url:source.url,contentSha256:source.contentSha256,quote:body}));
 return {input:{storyKey:sha,evidenceHash:sha,evidence:[{id:'e1',visibility:'public',sourceType:'rss',url:source.url}],sources:[source],history:{snapshotHash:sha,items:[],complete:true},now},result:{action:'approve',editorial,claims,publicationDate:'2026-11-16',scopeReason:'Relevant inference engine.',changeReason:'New engine release.',dedupReason:'No matching event in supplied history.'}};
}
test('verification request contains full untrusted sources/history and no tools or credentials',async()=>{
 const {input}=await fixture();const request=buildVerificationRequest(input,{model:'openai/gpt-oss-120b',maxOutputTokens:4096});
 assert.equal(request.model,'openai/gpt-oss-120b');assert.equal(request.provider.zdr,true);assert.equal(request.tools,undefined);
 assert.match(request.messages[0].content,/untrusted/i);assert.ok(request.messages[1].content.includes(body));
 assert.throws(()=>buildVerificationRequest({...input,history:{...input.history,complete:false}},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,apiKey:'must never forward'},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,evidence:[...input.evidence,{id:'private',visibility:'private',body:'private secret'}]},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,evidence:[{...input.evidence[0],sourceLinks:[{apiKey:'secret'}]}]},{model:request.model,maxOutputTokens:4096}));
});
test('approval validates exact captured source hashes/Unicode quote spans and original editorial claims',async()=>{
 const {input,result}=await fixture();const approved=await validateVerificationResult(result,input);
 assert.equal(approved.action,'approve');assert.equal(approved.judgment.method,'model-supported-primary-evidence');assert.equal(approved.judgment.historyHash,sha);
 assert.equal(approved.judgment.claims[0].quoteStart,0);assert.equal(approved.judgment.claims[0].quoteEnd,Array.from(body).length);
 for(const mutate of [r=>r.claims[0].quote='invented',r=>r.claims[0].contentSha256=sha,r=>r.claims[0].url='https://evil.example/x',r=>r.claims[0].quoteEnd=1,r=>r.claims.pop(),r=>r.editorial.political=true,r=>r.extra=true]){
  const copy=structuredClone(result);mutate(copy);await assert.rejects(validateVerificationResult(copy,input));
 }
});
test('incomplete/private/stale/future evidence and model defer cannot issue approval',async()=>{
 const {input,result}=await fixture();
 for(const mutate of [x=>x.sources[0].fetchedAt='2026-11-15T00:00:00Z',x=>x.sources[0].body+='changed',x=>x.evidence[0].visibility='private',x=>x.evidence[0].sourceType='bluesky',x=>x.history.complete=false]){
  const copy=structuredClone(input);mutate(copy);await assert.rejects(validateVerificationResult(result,copy));
 }
 assert.deepEqual(await validateVerificationResult({action:'defer',reason:'Insufficient primary evidence.'},input),{action:'defer',reason:'Insufficient primary evidence.'});
 const old=structuredClone(result);old.publicationDate='2026-10-01';await assert.rejects(validateVerificationResult(old,input));
});

test('native original approves only exact native repost with actual post date and record quotes',async()=>{
 const did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53),url=`https://bsky.app/profile/${did}/post/3m3e4a2b22222`,now=new Date().toISOString(),date=now.slice(0,10);
 const original={posts:[{uri,cid,author:{did,description:'Profile metadata is not original post evidence.'},record:{$type:'app.bsky.feed.post',text:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',createdAt:now},labels:[]}]},body=JSON.stringify(original);
 const contentSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');
 const evidence={id:'native:1',url,nativeUrl:url,nativeUri:uri,nativeCid:cid,nativeAuthorDid:did,text:'Discovery only.',sourceType:'bluesky',visibility:'public',sourceLinks:[url]};
 const input={storyKey:'a'.repeat(64),evidenceHash:'b'.repeat(64),evidence:[evidence],sources:[{evidenceId:evidence.id,url,contentSha256,fetchedAt:now,body,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(uri),nativeUri:uri,nativeCid:cid,nativeAuthorDid:did}],history:{snapshotHash:'c'.repeat(64),items:[],complete:true},now};
 const result={action:'approve',editorial:{mode:'repost',political:false,change:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',evidenceIds:[evidence.id]},publicationDate:date,scopeReason:'Direct work relevance.',changeReason:'A new capability.',dedupReason:'No previous event match.',claims:[{claim:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',quote:original.posts[0].record.text},{claim:date,quote:date}].map(c=>({...c,evidenceId:evidence.id,url,contentSha256}))};
 const out=await validateVerificationResult(result,input);assert.equal(out.editorial.mode,'repost');assert.equal(out.editorial.summary,undefined);assert.ok(out.judgment.claims.every(c=>Number.isInteger(c.quoteStart)));assert.equal(out.judgment.claims[0].originalQuote,original.posts[0].record.text);assert.equal(out.judgment.claims[0].quote,JSON.stringify(original.posts[0].record.text).slice(1,-1));assert.equal(Array.from(body).slice(out.judgment.claims[0].quoteStart,out.judgment.claims[0].quoteEnd).join(''),out.judgment.claims[0].quote);
 for(const mutate of [x=>x.editorial.summary='Invented commentary',x=>{delete x.editorial.mode;x.editorial.summary='A summary';x.editorial.whyItMatters='A reason';},x=>x.claims[0].quote=original.posts[0].author.description,x=>x.publicationDate='2000-01-01']){
  const bad=structuredClone(result);mutate(bad);await assert.rejects(()=>validateVerificationResult(bad,input));
 }
});
