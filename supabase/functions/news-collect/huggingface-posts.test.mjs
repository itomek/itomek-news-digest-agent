import test from 'node:test';import assert from 'node:assert/strict';
import {collectHuggingFacePostsPage} from './huggingface-posts.mjs';
const window={since:'2026-11-11T00:00:00Z',until:'2026-11-18T12:00:00Z',cursor:null};
const post=(slug,date='2026-11-17T12:00:00Z')=>({slug,author:{name:'researcher'},url:`/posts/researcher/${slug}`,rawContent:'A new agent capability',publishedAt:date,content:[{href:'https://openai.com/index/new-agent/'}]});
const response=posts=>new Response(JSON.stringify({socialPosts:posts}),{headers:{'content-type':'application/json'}});
test('HF collects one bounded page, retains community identity and resumes frozen window',async()=>{
 let calls=0;const first=await collectHuggingFacePostsPage({},async(url,opts)=>{calls++;assert.equal(url,'https://huggingface.co/api/posts?skip=0&sort=recent');assert.equal(opts.redirect,'error');return response([post('123')]);},window);
 assert.equal(calls,1);assert.equal(first.complete,false);assert.equal(first.cursor.skip,1);assert.equal(first.coverageGap,true);assert.equal(first.items[0].author,'researcher');assert.match(first.items[0].nativeUrl,/\/posts\/researcher\/123$/);
 const second=await collectHuggingFacePostsPage({},async url=>{assert.match(url,/skip=1&/);return response([post('122','2026-11-10T12:00:00Z')]);},{...window,cursor:first.cursor});assert.equal(second.complete,true);assert.equal(second.items.length,0);
});
test('HF rejects schema errors, invalid dates, repeated pages, redirects, oversize and caller-selected endpoints',async()=>{
 for(const p of [{...post('1'),url:'/posts/other/1'},{...post('1'),publishedAt:'yesterday'},{...post('1'),rawContent:''}])await assert.rejects(collectHuggingFacePostsPage({},async()=>response([p]),window));
 await assert.rejects(collectHuggingFacePostsPage({url:'https://evil.example'},async()=>response([]),window));
 await assert.rejects(collectHuggingFacePostsPage({},async()=>new Response('x'.repeat(1000001),{headers:{'content-type':'application/json'}}),window));
 await assert.rejects(collectHuggingFacePostsPage({},async()=>new Response('',{status:302}),window));
 await assert.rejects(collectHuggingFacePostsPage({},async()=>response([post('1')]),{...window,cursor:{skip:1,last:'https://huggingface.co/posts/researcher/1'}}));
 assert.equal((await collectHuggingFacePostsPage({},async()=>response([]),window)).complete,true);
});
