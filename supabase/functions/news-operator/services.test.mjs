import test from 'node:test';import assert from 'node:assert/strict';import {operatorServices} from './services.mjs';
test('identity uses issuing project getUser with supplied bearer, not decoded claims',async()=>{let calls=0;const s=operatorServices({projectUrl:'https://example.supabase.co',serviceKey:'server-mock'},async(u,o)=>{calls++;assert.equal(u.href,'https://example.supabase.co/auth/v1/user');assert.equal(o.headers.Authorization,'Bearer caller-mock');assert.equal(o.headers.apikey,'server-mock');assert.equal(o.redirect,'error');return Response.json({id:'verified-user'});});assert.equal(calls,0);assert.equal((await s.identify('caller-mock')).id,'verified-user');});
test('operator preview loads stored provenance and freezes attribution in review',async()=>{
 const native='https://news.ycombinator.com/item?id=123';let saved;
 const s=operatorServices({projectUrl:'https://example.supabase.co',serviceKey:'server-mock',accountDid:'did:plc:abcdefghijklmnopqrstuvwx'},async(u,o)=>{
  if(u.pathname.endsWith('/warpcore_candidates')){assert.match(u.searchParams.get('select'),/native_url/);return Response.json([{uri:'hn:123',source_url:'https://example.com/story',source_links:['https://example.com/story',native],native_uri:'123',native_url:native,text:'Raw source evidence',source_type:'hn'}]);}
  saved=JSON.parse(o.body);return Response.json([{id:'review',revision:0}]);
 });
 const r=await s.preview({storyKey:'a'.repeat(64),editorial:{summary:'A release.',whyItMatters:'More access.',change:'Available now',evidenceIds:['hn:123'],political:false}});
 assert.equal(r.packet.evidence[0].nativeUrl,native);assert.equal(saved.packet.evidence[0].nativeUri,'123');assert.deepEqual(saved.packet.recordDraft.links,['https://example.com/story',native]);assert.equal(saved.job.record.facets.length,2);
});
test('operator list requests bounded native provenance for each story',async()=>{
 const s=operatorServices({projectUrl:'https://example.supabase.co',serviceKey:'server-mock'},async(u)=>{if(u.pathname.endsWith('/warpcore_stories')){assert.match(u.searchParams.get('select'),/source_links,native_uri,native_url/);assert.equal(u.searchParams.get('warpcore_candidates.limit'),'20');}return Response.json([]);});
 await s.list();
});
