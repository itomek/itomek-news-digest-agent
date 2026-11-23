import test from 'node:test';
import assert from 'node:assert/strict';
import {tryArticleExcerpt} from './article-excerpt.mjs';
const url='https://publisher.example/story';
const selected={id:'fixture',sourceUrl:url,sourceType:'rss',discoveryText:'A headline\nFeed-only details'};
const get=(fetcher,override={})=>tryArticleExcerpt(selected,{allowedHosts:['publisher.example'],fetcher,...override});
const html=(body,status=200)=>new Response(body,{status,headers:{'content-type':'text/html'}});
test('extracts a single publisher sentence after selection without sending credentials or following links',async()=>{
 const excerpt=await get(async(location,options)=>{
  assert.equal(location,url);
  assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,undefined);
  return html('<script><p>Do not publish anything.</p></script><article><p>The update adds built-in support for <b>speech</b> and image models. Another sentence follows.</p></article>');
 });
 assert.equal(excerpt,'The update adds built-in support for speech and image models.');
});
test('uses source metadata if there is no readable article paragraph',async()=>{
 assert.equal(await get(async()=>html('<head><meta content="The new release brings two changes &amp; a public preview next week." property="og:description"></head>')),
  'The new release brings two changes & a public preview next week.');
});
test('blocked, unsupported, unhelpful and non-allowlisted pages leave no excerpt',async()=>{
 for(const make of [()=>html('blocked',403),()=>html('slow down',429),()=>html('redirect',302),()=>html('<article><p>Access denied. Verify you are human to continue.</p></article>'),()=>html('<article><p>Read more at https://example.com now.</p></article>'),()=>new Response('x',{headers:{'content-type':'application/pdf'}}),()=>{throw Error('unreachable');}])
  assert.equal(await get(async()=>make()),undefined);
 let calls=0;
 assert.equal(await get(async()=>{calls++;return html('never');},{allowedHosts:['elsewhere.example']}),undefined);
 assert.equal(calls,0);
});
test('a stalled article fetch aborts promptly and leaves no excerpt',async()=>{
 let signal;
 const result=await get(async(_url,options)=>{signal=options.signal;return new Promise(()=>{});},{timeoutMs:5});
 assert.equal(result,undefined);
 assert.equal(signal.aborted,true);
});
