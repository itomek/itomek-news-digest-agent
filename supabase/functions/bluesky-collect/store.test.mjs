import test from 'node:test';
import assert from 'node:assert/strict';
import {authorized,canonicalLink,candidateRow,persist} from './store.mjs';
const candidate={uri:'at://did:x/post/1',actor:'example.com',text:'AMD news',created_at:'2026-11-12T10:00:00Z',links:['https://example.com/story?utm_source=bsky#x']};
test('normalizes tracking only and refuses non-HTTPS/credentials',()=>{assert.equal(canonicalLink(candidate.links[0]),'https://example.com/story');assert.equal(canonicalLink('https://a:b@example.com'),null);assert.equal(canonicalLink('javascript:alert(1)'),null);assert.equal(canonicalLink('https://example.com/?version=2'),'https://example.com/?version=2');});
test('same story from different posts yields same persistent key',async()=>{const a=await candidateRow(candidate),b=await candidateRow({...candidate,uri:'at://did:y/post/2'});assert.equal(a.story_key,b.story_key);assert.notEqual(a.uri,b.uri);});
test('linkless posts retain distinct keys',async()=>{const a=await candidateRow({...candidate,links:[]}),b=await candidateRow({...candidate,links:[],uri:'at://did:y/post/2'});assert.notEqual(a.story_key,b.story_key);});
test('persistence delegates conflict handling to DB and never updates posted status',async()=>{let calls=0;const n=await persist([candidate,candidate],{projectUrl:'https://example.supabase.co',serviceKey:'test-only'},async(u,o)=>{calls++;assert.equal(u.pathname,'/rest/v1/rpc/warpcore_ingest');assert.equal(JSON.parse(o.body).items[0].status,'unverified_review_required');return new Response('',{status:201});});assert.equal(n,1);assert.equal(calls,1);});
test('auth fails closed without dedicated scheduler secret',async()=>{assert.equal(await authorized('x',undefined),false);assert.equal(await authorized('a'.repeat(32),'b'.repeat(32)),false);assert.equal(await authorized('a'.repeat(32),'a'.repeat(32)),true);});
test('preserves multiple sources for one story with provenance',async()=>{
 let rows;await persist([candidate,{...candidate,uri:'rss:1',source_type:'rss',source_id:'feed-a'}],{projectUrl:'https://example.supabase.co',serviceKey:'test'},async(u,o)=>{rows=JSON.parse(o.body).items;return new Response('');});
 assert.equal(rows.length,2);assert.equal(rows[1].source_type,'rss');assert.equal(rows[1].source_id,'feed-a');assert.equal(rows[0].story_key,rows[1].story_key);
});
