import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOfficialHTML} from './official-html.mjs';
const config={url:'https://www.perplexity.ai/hub/blog',label:'Perplexity Blog'};
const now=Date.parse('2026-11-15T12:00:00Z');
const fails=async(fetcher,code)=>{
 await assert.rejects(()=>collectOfficialHTML(config,fetcher,now),error=>{assert.equal(error.code,code);assert.equal(error.message,code);assert.doesNotMatch(JSON.stringify(error),/secret|credential|https:/);return true;});
};
test('official source diagnostics distinguish HTTP status and unexpected content type',async()=>{
 for(const status of [403,404,429,503])await fails(async()=>new Response('secret upstream body',{status}),`source_http_${status}`);
 await fails(async()=>new Response('secret upstream body',{headers:{'content-type':'application/json'}}),'source_content_type');
});
test('official source diagnostics sanitize fetch and streaming network failures',async()=>{
 await fails(async()=>{throw new TypeError('secret URL credential');},'source_network');
 await fails(async()=>{throw new DOMException('secret URL credential','TimeoutError');},'source_timeout');
 await fails(async()=>{throw new DOMException('secret URL credential','AbortError');},'source_timeout');
 await fails(async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('secret streaming credential'));}}),{headers:{'content-type':'text/html'}}),'source_network');
 await fails(async()=>new Response(null,{headers:{'content-type':'text/html'}}),'source_network');
});
test('official source diagnostics retain body bound and sanitize parser failures',async()=>{
 await fails(async()=>new Response('x'.repeat(1000001),{headers:{'content-type':'text/html'}}),'source_body_limit');
 await fails(async()=>new Response('<html>secret changed layout</html>',{headers:{'content-type':'text/html'}}),'source_parse_failed');
});
test('official source diagnostic changes preserve successful bounded parsing and request policy',async()=>{
 const html='<script>window.__PPL_INITIAL_SERVER_DATA__={"items":[{"slug":"announcement","title":"Announcement","publishedAt":"2026-11-14"}]};window.__PPL_INITIAL_SESSION__=null;</script>';
 const items=await collectOfficialHTML(config,async(url,options)=>{assert.equal(url,config.url);assert.equal(options.redirect,'error');assert.equal(options.headers['User-Agent'],'Mozilla/5.0 (compatible; WarpCorePublicNews/1.0)');assert.ok(options.signal);return new Response(html,{headers:{'content-type':'text/html'}});},now);
 assert.equal(items.length,1);assert.equal(items[0].url,'https://www.perplexity.ai/hub/blog/announcement');
});
