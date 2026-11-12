import test from 'node:test';import assert from 'node:assert/strict';import * as r from './runtime.mjs';
const did='did:plc:abcdefghijklmnopqrstuvwx';
const config={enabled:true,accountDid:did,pdsUrl:'https://bsky.social',accessToken:'mock',projectUrl:'https://example.supabase.co',serviceKey:'mock'};
test('runtime defaults disabled without any requests',async()=>{assert.equal(typeof r.initialize,'function');assert.deepEqual(await r.initialize({},()=>{throw Error('unexpected');}),{enabled:false});});
test('verifies DID document PDS before sending token and validates session identity',async()=>{const calls=[];const runtime=await r.initialize(config,async(url,o)=>{calls.push(String(url));if(String(url).includes('plc.directory')){assert.equal(o.headers?.Authorization,undefined);return Response.json({id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:'https://bsky.social'}]});}return Response.json({did,active:true});});assert.equal(runtime.enabled,true);assert.equal(calls.length,2);});
test('wrong DID document prevents credential transmission',async()=>{let calls=0;await assert.rejects(()=>r.initialize(config,async()=>{calls++;return Response.json({id:did,service:[{id:'#atproto_pds',serviceEndpoint:'https://different.bsky.network'}]});}));assert.equal(calls,1);});
test('mismatched session blocks runtime',async()=>{await assert.rejects(()=>r.initialize(config,async url=>String(url).includes('plc.directory')?Response.json({id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:'https://bsky.social'}]}):Response.json({did:'wrong'})));});
test('composed workflow persists exact record then claims and sends once',async()=>{
 let stored,puts=0;const calls=[];
 const runtime=await r.initialize(config,async(url,o)=>{
 const u=String(url);calls.push(u);const b=o.body?JSON.parse(o.body):null;
 if(u.includes('plc.directory'))return Response.json({id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:'https://bsky.social'}]});
 if(u.includes('getSession'))return Response.json({did});
 if(u.includes('prepare_publication')){stored=b;return Response.json(true);}
 if(u.includes('claim_publication'))return Response.json([{account_did:did,story_key:stored.p_story,content_hash:stored.p_hash,record_key:stored.p_key,record_payload:stored.p_record}]);
 if(u.includes('mark_uncertain'))return Response.json(true);
 if(u.includes('putRecord')){puts++;assert.deepEqual(b.record,stored.p_record);assert.equal(b.swapRecord,null);return Response.json({uri:`at://${did}/app.bsky.feed.post/${stored.p_key}`});}
 if(u.includes('getRecord'))return Response.json({value:stored.p_record,uri:`at://${did}/app.bsky.feed.post/${stored.p_key}`});
 if(u.includes('mark_published'))return Response.json(true);
 throw Error('Unexpected request');
 });
 const result=await runtime.prepareAndSend({storyKey:'a'.repeat(64),summary:'A release.',whyItMatters:'Useful capability.',links:['https://example.com/news'],verified:true,approved:true},'2026-11-12T12:00:00Z');
 assert.equal(result.state,'published');assert.equal(puts,1);assert.equal(calls.length,8);
});
