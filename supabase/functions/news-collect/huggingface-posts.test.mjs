import test from 'node:test';import assert from 'node:assert/strict';
import {collectHuggingFacePosts as collector} from './huggingface-posts.mjs';
const collectHuggingFacePosts=(c,f,n)=>collector(c,f,n,async()=>{});
const now=Date.parse('2026-11-13T19:00:00Z');
const post=(slug='123',date='2026-11-13T18:00:00Z',extra={})=>({slug,author:{name:'tester'},url:`/posts/tester/${slug}`,publishedAt:date,rawContent:'Model announcement https://example.org/model',content:[{type:'link',href:'https://example.org/model'}],...extra});
const response=posts=>Response.json({socialPosts:posts,numTotalItems:800});
test('preserves author and canonical post, with a safe primary link',async()=>{
 const calls=[];const result=await collectHuggingFacePosts({},async(u,o)=>{calls.push([u,o]);return response(calls.length===1?[post()]:[]);},now);
 assert.equal(result.length,1);assert.equal(result[0].url,'https://example.org/model');assert.equal(result[0].nativeUrl,'https://huggingface.co/posts/tester/123');assert.equal(result[0].author,'tester');assert.equal(result[0].visibility,'public');
 assert.equal(calls[0][0],'https://huggingface.co/api/posts?skip=0&sort=recent');assert.equal(calls[1][0],'https://huggingface.co/api/posts?skip=1&sort=recent');assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].headers.Authorization,undefined);
});
test('pages to seven-day boundary, not arbitrary review quota',async()=>{
 let page=0;const result=await collectHuggingFacePosts({},async()=>response(++page===1?[post('1')]:[post('2','2026-11-06T19:00:00Z'),post('3','2026-11-06T18:59:59Z')]),now);
 assert.equal(page,2);assert.deepEqual(result.map(p=>p.id),['https://huggingface.co/posts/tester/1','https://huggingface.co/posts/tester/2']);
});
test('does not follow unsafe links or collect future posts',async()=>{
 let n=0;const result=await collectHuggingFacePosts({},async()=>response(n++?[]:[post('2','2026-11-13T20:00:00Z'),post('1',undefined,{content:[{href:'https://user:pass@example.org/a'},{href:'http://example.org/a'},{href:'javascript:alert(1)'}]})]),now);
 assert.equal(result.length,1);assert.equal(result[0].url,result[0].nativeUrl);
});
test('rejects schema or identity changes, repeated pages and unsorted pages',async()=>{
 for(const bad of [{}, {socialPosts:'bad'}, {socialPosts:[post('1',undefined,{url:'/posts/other/1'})]}, {socialPosts:[post('1','bad')]}, {socialPosts:[post('1','2026-11-13T17:00:00Z'),post('2')]}])await assert.rejects(()=>collectHuggingFacePosts({},async()=>Response.json(bad),now));
 await assert.rejects(()=>collectHuggingFacePosts({},async()=>response([post()]),now));
});
test('fails closed on response errors and resource overflow',async()=>{
 for(const res of [new Response('blocked',{status:403}),new Response('{}',{headers:{'Content-Type':'text/html'}}),new Response('x'.repeat(1000001),{headers:{'Content-Type':'application/json'}})])await assert.rejects(()=>collectHuggingFacePosts({},async()=>res,now));
 let n=0;await assert.rejects(()=>collectHuggingFacePosts({},async()=>response(Array.from({length:100},()=>post(String(++n)))),now));
});
test('rejects arbitrary configuration endpoints',async()=>{await assert.rejects(()=>collectHuggingFacePosts({url:'https://evil.test'},async()=>response([]),now));});

test('waits one second between pages but not before first request',async()=>{
 const events=[];let n=0;await collector({},async()=>{events.push('fetch');return response(n++?[]:[post()]);},now,async ms=>events.push(ms));
 assert.deepEqual(events,['fetch',1000,'fetch']);
});
