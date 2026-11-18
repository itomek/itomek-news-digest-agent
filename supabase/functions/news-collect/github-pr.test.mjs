import test from 'node:test';import assert from 'node:assert/strict';import {collectGithubPRPage} from './github-pr.mjs';
const window={since:'2026-11-18T00:00:00Z',until:'2026-11-19T00:00:00Z'},row=(n,merged_at)=>({number:n,title:'New capability',body:'Details',updated_at:'2026-11-18T12:00:00Z',merged_at,html_url:'https://github.com/lemonade-sdk/lemonade/pull/'+n,base:{repo:{full_name:'lemonade-sdk/lemonade'}}});
test('only merged in-window Lemonade PRs become candidates, retaining API proof and merge/release distinction',async()=>{
 const result=await collectGithubPRPage({repo:'lemonade-sdk/lemonade'},async url=>{assert.ok(url.startsWith('https://api.github.com/repos/lemonade-sdk/lemonade/pulls?'));return Response.json([row(1,'2026-11-18T12:00:00Z'),row(2,null),row(3,'2026-11-17T12:00:00Z')]);},window);
 assert.equal(result.complete,true);assert.equal(result.items.length,1);assert.equal(result.items[0].nativeUrl,'https://api.github.com/repos/lemonade-sdk/lemonade/pulls/1');assert.match(result.items[0].text,/does not establish release availability/);
});
test('foreign repo, malformed identity and upstream failures never certify completion',async()=>{
 await assert.rejects(()=>collectGithubPRPage({repo:'unknown/repo'},()=>assert.fail(),window));
 for(const value of [Response.json([{...row(1,'2026-11-18T12:00:00Z'),html_url:'https://evil.example/1'}]),new Response('',{status:429})])await assert.rejects(()=>collectGithubPRPage({repo:'lemonade-sdk/lemonade'},async()=>value,window));
});
