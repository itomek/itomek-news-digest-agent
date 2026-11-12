import test from 'node:test';import assert from 'node:assert/strict';import * as s from './services.mjs';
const now=Date.parse('2026-11-12T12:00:00Z');
const config={accountDid:'did:plc:abcdefghijklmnopqrstuvwx',dotId:'test-dot'};
const row={id:'11111111-1111-4111-8111-111111111111',lease_token:'22222222-2222-4222-8222-222222222222',lease_expires_at:new Date(now+60000).toISOString(),created_at:new Date(now-1000).toISOString(),story_key:'a'.repeat(64),actor_kind:'dot',evidence_hash:'b'.repeat(64),dot_id:config.dotId,run_id:'33333333-3333-4333-8333-333333333333',evidence:[{id:'e1',url:'https://example.com/release',text:'Raw public evidence',sourceType:'rss',visibility:'public',sourceLinks:['https://example.com/release'],nativeUri:null,nativeUrl:null}],editorial:{summary:'A release expands access.',whyItMatters:'More users can try it.',change:'New availability',political:false,evidenceIds:['e1']},attestations:{factsVerified:true,meaningfulChange:true,scopeApproved:true}};
function dbFor(item=row){return {claim:async n=>{assert.equal(n,1);return [structuredClone(item)];},snapshot:async()=>({story_key:item.story_key,evidence_hash:item.evidence_hash,evidence:structuredClone(item.evidence)}),finalize:async()=>true,fail:async()=>true};}
test('drain leases one item and finalizes exact frozen record without publishing',async()=>{assert.equal(typeof s.drainOne,'function');const db=dbFor();let got;db.finalize=async(r,p,j)=>{got={r,p,j};return true;};const out=await s.drainOne(config,db,now);assert.deepEqual(out,[{state:'approved'}]);assert.equal(got.r.run_id,row.run_id);assert.equal(got.p.approved,false);assert.equal(got.j.record.createdAt,row.created_at);assert.equal(got.j.record.facets.length,1);assert.equal(got.j.accountDid,config.accountDid);});
test('current opaque SQL hash mismatch fails without finalize',async()=>{const db=dbFor();db.snapshot=async()=>({story_key:row.story_key,evidence_hash:'changed',evidence:row.evidence});db.finalize=async()=>{throw Error('must not finalize');};let reason;db.fail=async(r,x)=>{reason=x;return true;};assert.deepEqual(await s.drainOne(config,db,now),[{state:'rejected'}]);assert.equal(reason,'stale_evidence');});
test('equal hash with changed snapshot fails closed',async()=>{const db=dbFor();db.snapshot=async()=>({story_key:row.story_key,evidence_hash:row.evidence_hash,evidence:[]});assert.deepEqual(await s.drainOne(config,db,now),[{state:'rejected'}]);});
test('wrong dot, missing review attestation, expired lease and invalid run are rejected',async()=>{for(const change of [{actor_kind:'user'},{dot_id:'other'},{attestations:{factsVerified:true}},{lease_expires_at:new Date(now-1).toISOString()},{run_id:'not-a-run'}])assert.deepEqual(await s.drainOne(config,dbFor({...row,...change}),now),[{state:'rejected'}]);});
test('uncertain finalize is never automatically resubmitted or failed',async()=>{const db=dbFor();let calls=0;db.finalize=async()=>{calls++;throw Error('network uncertain');};db.fail=async()=>{throw Error('must not mark failed after uncertain finalize');};assert.deepEqual(await s.drainOne(config,db,now),[{state:'finalization_uncertain'}]);assert.equal(calls,1);});
test('false finalize is conflict, not approval; empty batch idle',async()=>{const db=dbFor();db.finalize=async()=>false;assert.deepEqual(await s.drainOne(config,db,now),[{state:'conflict'}]);db.claim=async()=>[];assert.deepEqual(await s.drainOne(config,db,now),[]);});
test('canonical snapshot equality permits JSON key ordering differences',async()=>{const db=dbFor();db.snapshot=async()=>({story_key:row.story_key,evidence_hash:row.evidence_hash,evidence:row.evidence.map(e=>Object.fromEntries(Object.entries(e).reverse()))});assert.deepEqual(await s.drainOne(config,db,now),[{state:'approved'}]);});
test('DB verification outage defers lease and never finalizes or rejects',async()=>{const db=dbFor();db.snapshot=async()=>{throw Error('outage');};db.fail=db.finalize=async()=>{throw Error('must not call');};assert.deepEqual(await s.drainOne(config,db,now),[{state:'verification_deferred'}]);});
test('database adapter calls only fixed RPCs with bounded claim and no publisher transport',async()=>{
 const live={...row,created_at:new Date(Date.now()-1000).toISOString(),lease_expires_at:new Date(Date.now()+60000).toISOString()};const calls=[];
 const service=s.createCuratorService({...config,projectUrl:'https://example.supabase.co',serviceKey:'fixture'},async(url,o)=>{
 assert.equal(url.origin,'https://example.supabase.co');assert.equal(o.redirect,'error');assert.equal(o.method,'POST');assert.equal(o.headers.Authorization,'Bearer fixture');assert.equal(o.headers.apikey,'fixture');calls.push(url.pathname);const body=JSON.parse(o.body);
 if(url.pathname.endsWith('_claim')){assert.deepEqual(body,{p_limit:5});return Response.json([live]);}
 if(url.pathname.endsWith('_snapshot')){assert.deepEqual(body,{p_story:row.story_key});return Response.json({story_key:row.story_key,evidence_hash:row.evidence_hash,evidence:row.evidence});}
 assert.equal(url.pathname,'/rest/v1/rpc/warpcore_curator_finalize');assert.equal(body.p_id,row.id);assert.equal(body.p_lease_token,row.lease_token);assert.equal(body.p_packet.approved,false);assert.equal(body.p_job.storyKey,row.story_key);return Response.json(true);
 });
 assert.deepEqual(await service.drain(),[{state:'approved'}]);assert.equal(calls.length,3);
});
test('noncanonical persisted URLs are terminally rejected before record formatting',async()=>{
 for(const change of [{url:'https://EXAMPLE.com/release'},{url:'https://example.com'},{nativeUrl:'https://EXAMPLE.com/native'},{sourceLinks:['https://example.com:443/release']},{url:'https://user:pass@example.com/release'}]){
  const bad={...row,evidence:[{...row.evidence[0],...change}]};const db=dbFor(bad);let reason;
  db.fail=async(r,x)=>{reason=x;return true;};db.finalize=async()=>{throw Error('must not finalize');};
  assert.deepEqual(await s.drainOne(config,db,now),[{state:'rejected'}]);assert.equal(reason,'noncanonical_evidence');
 }
});
test('batch leases at most five and finalizes separate records sequentially',async()=>{
 const rows=Array.from({length:5},(_,i)=>({...structuredClone(row),id:`11111111-1111-4111-8111-11111111111${i}`,story_key:String(i).repeat(64)}));
 let active=0,max=0;const completed=[];const db={claim:async n=>{assert.equal(n,5);return rows;},snapshot:async key=>{const item=rows.find(r=>r.story_key===key);return {story_key:key,evidence_hash:item.evidence_hash,evidence:item.evidence};},finalize:async(r,p,j)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));completed.push(j.storyKey);active--;return true;},fail:async()=>{throw Error('unexpected');}};
 assert.deepEqual(await s.drainBatch(config,db,now),Array(5).fill({state:'approved'}));assert.equal(max,1);assert.deepEqual(completed,rows.map(r=>r.story_key));
 db.claim=async()=>[...rows,row];await assert.rejects(()=>s.drainBatch(config,db,now),/bounded/);
});
test('batch never retries uncertain finalization and continues independent stories',async()=>{
 const rows=[row,{...structuredClone(row),id:'44444444-4444-4444-8444-444444444444',story_key:'c'.repeat(64)}];const calls=[];const db=dbFor();db.claim=async()=>rows;db.snapshot=async key=>({story_key:key,evidence_hash:row.evidence_hash,evidence:row.evidence});db.finalize=async r=>{calls.push(r.id);if(r===row)throw Error('uncertain');return true;};
 assert.deepEqual(await s.drainBatch(config,db,now),[{state:'finalization_uncertain'},{state:'approved'}]);assert.deepEqual(calls,rows.map(r=>r.id));
});
