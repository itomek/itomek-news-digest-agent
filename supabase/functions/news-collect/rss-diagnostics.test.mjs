import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRSS} from './rss.mjs';
const config={url:'https://rocm.blogs.amd.com/blog/atom.xml',label:'ROCm'};
const now=Date.parse('2026-11-15T00:00:00Z');
const rejects=(fetcher,code)=>assert.rejects(()=>collectRSS(config,fetcher,now),error=>error.code===code);
test('RSS HTTP failures expose only fixed status codes, never upstream body',async()=>{
 for(const status of [403,429,500,503])await rejects(async()=>new Response('private upstream diagnostic',{status}),`source_http_${status}`);
});
test('RSS distinguishes content type, parse, and body size failures',async()=>{
 await rejects(async()=>new Response('<html/>',{headers:{'content-type':'text/html'}}),'source_content_type');
 await rejects(async()=>new Response('<rss>',{headers:{'content-type':'application/xml'}}),'source_parse_failed');
 await rejects(async()=>new Response('x'.repeat(1000001),{headers:{'content-type':'application/xml'}}),'source_body_limit');
});
test('RSS classifies fetch timeout and network failure without forwarding arbitrary codes',async()=>{
 await rejects(async()=>{throw new DOMException('private timeout details','TimeoutError');},'source_timeout');
 await rejects(async()=>{throw new DOMException('private abort details','AbortError');},'source_timeout');
 await rejects(async()=>{throw Object.assign(new Error('private network details'),{code:'untrusted_secret'});},'source_network');
});
test('RSS body read failure is sanitized and safety request options remain enforced',async()=>{
 await rejects(async(url,options)=>{
  assert.equal(url,config.url);assert.equal(options.redirect,'error');assert.ok(options.signal);
  return new Response(new ReadableStream({start(controller){controller.error(new Error('private stream details'));}}),{headers:{'content-type':'application/xml'}});
 },'source_network');
});
