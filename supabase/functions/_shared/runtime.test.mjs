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
 if(u.includes('mark_checked'))return Response.json(true);
 if(u.includes('mark_uncertain'))return Response.json(true);
 if(u.includes('putRecord')){puts++;assert.deepEqual(b.record,stored.p_record);assert.equal(b.swapRecord,null);return Response.json({uri:`at://${did}/app.bsky.feed.post/${stored.p_key}`});}
 if(u.includes('getRecord'))return Response.json({value:stored.p_record,uri:`at://${did}/app.bsky.feed.post/${stored.p_key}`});
 if(u.includes('mark_published'))return Response.json(true);
 throw Error('Unexpected request');
 });
 const result=await runtime.prepareAndSend({storyKey:'a'.repeat(64),summary:'A release.',whyItMatters:'Useful capability.',links:['https://example.com/news'],verified:true,approved:true},'2026-11-12T12:00:00Z');
 assert.equal(result.state,'published');assert.equal(puts,1);assert.equal(calls.length,9);
});
test('pending batch sends five distinct posts sequentially; published and uncertain never resend',async()=>{
 const {prepareTransport}=await import('./transport.mjs');
 const rows=await Promise.all(Array.from({length:5},async(_,i)=>{
  const story=String(i).repeat(64);const j=await prepareTransport({storyKey:story,summary:`Release ${i}.`,whyItMatters:'Useful capability.',links:['https://example.com/news'],verified:true,approved:true},did,'2026-11-12T12:00:00Z');
  return {account_did:did,story_key:story,content_hash:j.contentHash,record_key:j.recordKey,record_payload:j.record,state:'prepared'};
 }));
 const puts=[],completed=[];let active=0,max=0;
 const runtime=await r.initialize(config,async(url,o)=>{
  const u=new URL(url),b=o.body?JSON.parse(o.body):null;
  if(u.hostname==='plc.directory')return Response.json({id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:'https://bsky.social'}]});
  if(u.pathname.endsWith('getSession'))return Response.json({did});
  if(u.pathname.endsWith('/warpcore_publications')){assert.equal(u.searchParams.get('limit'),'5');assert.equal(u.searchParams.get('state'),'in.(prepared,sending,uncertain)');return Response.json(rows.filter(r=>r.state!=='published'));}
  const row=rows.find(r=>r.story_key===b?.p_story||r.record_key===(b?.rkey??u.searchParams.get('rkey')));
  if(u.pathname.endsWith('claim_publication')){if(row.state!=='prepared')return Response.json([]);row.state='sending';return Response.json([row]);}
  if(u.pathname.endsWith('mark_uncertain')){row.state='uncertain';return Response.json(true);}
  if(u.pathname.endsWith('putRecord')){
   active++;max=Math.max(max,active);puts.push(b.rkey);await new Promise(resolve=>setTimeout(resolve,2));active--;
   if(row===rows[2])throw Error('ambiguous network outcome');
   return Response.json({uri:`at://${did}/app.bsky.feed.post/${row.record_key}`});
  }
  if(u.pathname.endsWith('getRecord')){if(row===rows[2])throw Error('not found');return Response.json({value:row.record_payload,uri:`at://${did}/app.bsky.feed.post/${row.record_key}`});}
  if(u.pathname.endsWith('mark_checked'))return Response.json(true);
  if(u.pathname.endsWith('mark_published')){row.state='published';completed.push(row.story_key);return Response.json(true);}
  throw Error('Unexpected request '+u.pathname);
 });
 const first=await runtime.runPending();assert.deepEqual(first.map(r=>r.state),['published','published','uncertain','published','published']);assert.equal(max,1);assert.deepEqual(puts,rows.map(r=>r.record_key));assert.equal(new Set(puts).size,5);
 assert.deepEqual(await runtime.runPending(),[{state:'uncertain'}]);assert.equal(puts.length,5);assert.equal(completed.length,4);
});
