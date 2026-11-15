import test from 'node:test';import assert from 'node:assert/strict';import * as h from './handler.mjs';
const token='a'.repeat(32);const req=()=>new Request('https://example.com',{method:'POST',headers:{'x-warpcore-token':token}});
const upper='2026-11-15T00:00:00Z';
const options=(finish=async args=>({accepted:true,status:args.p_outcome,new:args.p_items.length}))=>({upper,store:{begin:async()=>({acquired:true,token:'fixture',window_since:'2026-11-08T00:00:00Z',window_until:upper,cursor:null}),finish}});
const page=items=>({items,complete:true,cursor:null,coverageGap:false,fetchedCount:items.length});
test('unconfigured endpoint is idle without network or persistence',async()=>{assert.equal(typeof h.handle,'function');const response=await h.handle(req(),{WARPCORE_CRON_TOKEN:token},{});assert.equal(response.status,200);assert.equal((await response.json()).mode,'idle');});
test('rejects unauthenticated requests before collection',async()=>{const r=await h.handle(req(),{},{});assert.equal(r.status,401);});
test('selected adapter persists evidence and checkpoint together without publishing',async()=>{let saved;const r=await h.handle(req(),{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:JSON.stringify([{id:'test',adapter:'fixture'}])},{fixture:{collectPage:async()=>page([{id:'1',text:'release',url:'https://example.com',publishedAt:'2026-11-12',visibility:'public'}])}},options(async args=>{saved=args;return {accepted:true,status:args.p_outcome};}));assert.equal(r.status,200);assert.equal(saved.p_items[0].source_id,'test');assert.equal(saved.p_outcome,'complete');assert.equal((await r.json()).publishing_enabled,false);});
test('all-source failure is not successful empty collection',async()=>{const r=await h.handle(req(),{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:'[{"id":"x","adapter":"unknown"}]'},{},options());assert.equal(r.status,502);});
test('accepts bounded expanded roster while retaining authentication and review-only mode',async()=>{
 const sources=Array.from({length:24},(_,i)=>({id:`s${i}`,adapter:'rss'}));
 const r=await h.handle(req(),{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:JSON.stringify(sources)},{rss:{collectPage:async()=>page([])}},options());
 assert.equal(r.status,200);const result=await r.json();assert.equal(result.publishing_enabled,false);assert.equal(result.sources.length,24);assert.ok(result.sources.every(source=>source.status==='empty'));
});
test('duplicate source keys and multiple HN scanners reject before collection',async()=>{
 for(const selections of [[{id:'same',adapter:'rss'},{id:'same',adapter:'rss'}],[{id:'a',adapter:'hn'},{id:'b',adapter:'hn'}]]){
 const response=await h.handle(req(),{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:JSON.stringify(selections)},{},options());assert.equal(response.status,503);
 }
});
test('authenticated recovery selects only existing configured source IDs',async()=>{
 const sources=[{id:'a',adapter:'rss'},{id:'b',adapter:'rss'}];const calls=[];
 const request=new Request('https://example.com',{method:'POST',headers:{'x-warpcore-token':token},body:JSON.stringify({source_ids:['b']})});
 const response=await h.handle(request,{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:JSON.stringify(sources)},{rss:{collectPage:async()=>page([])}},options(async args=>{calls.push(args.p_source_key);return {accepted:true,status:args.p_outcome};}));
 assert.equal(response.status,200);assert.deepEqual(calls,['rss:b']);
});
test('recovery rejects unknown source IDs, arbitrary configuration, duplicates and oversized bodies before persistence',async()=>{
 for(const body of [JSON.stringify({source_ids:['missing']}),JSON.stringify({source_ids:['a','a']}),JSON.stringify({source_ids:[]}),JSON.stringify({source_ids:['a'],config:{url:'https://example.com'}}),' '.repeat(4097)]){
  let called=false;const request=new Request('https://example.com',{method:'POST',headers:{'x-warpcore-token':token},body});
  const response=await h.handle(request,{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:'[{"id":"a","adapter":"rss"}]'},{}, {store:{begin:async()=>{called=true;}}});
  assert.equal(response.status,400);assert.equal(called,false);
 }
});
