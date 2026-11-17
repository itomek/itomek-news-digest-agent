import test from 'node:test';import assert from 'node:assert/strict';
import {githubReleaseIdentity,fetchGithubReleaseEvidence,validateGithubReleaseCapture} from './github-release-verification.mjs';
const url='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1',now=new Date().toISOString(),evidence={id:'release:1',url,sourceType:'rss',visibility:'public',sourceLinks:[url]},data={html_url:url,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:now,body:'Actual full release notes.'};
test('only reviewed exact release URLs map to fixed anonymous API GET',async()=>{
 for(const bad of [url+'?x=1',url+'/',url.replace('lemonade-sdk','attacker'),url.replace('/tag/v2026.47.1',''),url.replace('v2026.47.1','%2e%2e'),url.replace('github.com','api.github.com')])assert.throws(()=>githubReleaseIdentity(bad));
 const capture=await fetchGithubReleaseEvidence({url,evidence,now:()=>now,fetcher:async(u,o)=>{assert.equal(u,'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1');assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(o.credentials,'omit');assert.equal(o.headers.Authorization,undefined);return Response.json(data);}});
 assert.equal(capture.url,url);assert.equal(capture.captureKind,'github-release-v1');assert.equal(capture.body,JSON.stringify(data));assert.equal(validateGithubReleaseCapture(capture,evidence,now).publicationDate,now.slice(0,10));
 for(const patch of [{html_url:url+'/other'},{tag_name:'other'},{draft:true},{prerelease:'false'},{published_at:'2020-01-01T00:00:00Z'},{body:null}])assert.throws(()=>validateGithubReleaseCapture({...capture,body:JSON.stringify({...data,...patch})},evidence,now));
 for(const patch of [{fetchedUrl:capture.fetchedUrl+'/other'},{captureKind:'html'},{evidenceId:'other'}])assert.throws(()=>validateGithubReleaseCapture({...capture,...patch},evidence,now));
});
test('invalid evidence makes no request and oversized API JSON is never truncated',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({...data,body:'x'.repeat(100001)});};
 for(const bad of [{...evidence,visibility:'private'},{...evidence,url:'https://github.com/other/repo/releases/tag/x',sourceLinks:[]},{...evidence,sourceType:'bluesky'}])await assert.rejects(fetchGithubReleaseEvidence({url,evidence:bad,fetcher}));assert.equal(calls,0);
 await assert.rejects(fetchGithubReleaseEvidence({url,evidence,fetcher}));assert.equal(calls,1);
});
test('decoded API JSON rejects PostgreSQL-unsafe strings before paid continuation',async()=>{
 for(const extra of [{description:'\u0000'},{assets:[{description:'\ud800'}]},{['bad\udfff']:'value'},{assets:[{['bad\u0000']:'value'}]}]){
  let reservations=0,modelCalls=0;
  await assert.rejects((async()=>{await fetchGithubReleaseEvidence({url,evidence,now:()=>now,fetcher:async()=>Response.json({...data,...extra})});reservations++;modelCalls++;})());
  assert.equal(reservations,0);assert.equal(modelCalls,0);
 }
 let nested='safe';for(let i=0;i<42;i++)nested={nested};await assert.rejects(fetchGithubReleaseEvidence({url,evidence,now:()=>now,fetcher:async()=>Response.json({...data,nested})}));
 const extra={description:'Valid 🦀 emoji\nnewline',assets:[{size:42,enabled:true,optional:null,'🦀':'valid'}]};
 const capture=await fetchGithubReleaseEvidence({url,evidence,now:()=>now,fetcher:async()=>Response.json({...data,...extra})});assert.equal(capture.body,JSON.stringify({...data,...extra}));
});
