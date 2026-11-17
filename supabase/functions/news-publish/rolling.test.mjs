// Full publisher composition with synthetic local HTTP responses only.
import test from 'node:test';import assert from 'node:assert/strict';
import {handlePublish} from './handler.mjs';
const did='did:plc:abcdefghijklmnopqrstuvwx',pds='https://unit.bsky.network',project='https://fixture.supabase.co',token='x'.repeat(32),password='synthetic-not-a-secret';
const env={WARPCORE_PUBLISH_CRON_TOKEN:token,WARPCORE_PUBLISH_ENABLED:'true',BLUESKY_ACCOUNT_DID:did,BLUESKY_IDENTIFIER:'warp-core.bsky.social',BLUESKY_APP_PASSWORD:password,SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'};
const request=()=>new Request('https://fixture.invalid/news-publish',{method:'POST',headers:{'x-warpcore-token':token},body:'{}'});
function fixture({wrongReadback=false}={}){
 const jobs=[],records=new Map(),events=[];let reserved=0,publicationAttempts=0;
 const tuple=(job,body)=>{assert.equal(body.p_account,did);assert.equal(body.p_story,job.story_key);assert.equal(body.p_hash,job.content_hash);assert.deepEqual(body.p_record,job.record_payload);};
 const add=n=>{const rkey='3m3e4a2b2222'+'234567'[n-1],job={account_did:did,story_key:String(n).repeat(64),content_hash:'hash-'+n,record_key:rkey,record_payload:{$type:'app.bsky.feed.post',text:'Synthetic verified post '+n,createdAt:'2026-11-17T16:00:00Z'},state:'prepared'};jobs.push(job);return job;};
 const fetcher=async(raw,options={})=>{const url=new URL(raw),path=url.pathname;events.push(path);assert.equal(options.redirect,'error');
  if(path==='/xrpc/com.atproto.identity.resolveHandle')return Response.json({did});
  if(url.hostname==='plc.directory')return Response.json({id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:pds}]});
  if(path==='/xrpc/com.atproto.server.createSession'){assert.deepEqual(JSON.parse(options.body),{identifier:did,password});return Response.json({did,active:true,accessJwt:'synthetic-access'});}
  if(path==='/xrpc/com.atproto.server.getSession'){assert.equal(options.headers.Authorization,'Bearer synthetic-access');return Response.json({did,active:true});}
  if(path==='/rest/v1/warpcore_publications'){assert.equal(url.searchParams.get('state'),'in.(prepared,sending,uncertain)');assert.equal(url.searchParams.get('warpcore_stories.status'),'eq.approved');return Response.json(jobs.filter(j=>['prepared','sending','uncertain'].includes(j.state)).map(j=>structuredClone(j)));}
  if(path.startsWith('/rest/v1/rpc/')){const name=path.split('/').at(-1),body=JSON.parse(options.body);if(name==='warpcore_reserve_login'){assert.equal(body.p_account,did);if(reserved===5)return Response.json(false);reserved++;return Response.json(true);}
   const job=jobs.find(j=>j.story_key===body.p_story);assert.ok(job);tuple(job,body);
   if(name==='warpcore_claim_publication'){if(job.state!=='prepared'||publicationAttempts===5)return Response.json([]);publicationAttempts++;job.state='sending';return Response.json([structuredClone(job)]);}
   if(name==='warpcore_mark_uncertain'){assert.equal(job.state,'sending');job.state='uncertain';return Response.json(true);}
   if(name==='warpcore_mark_checked')return Response.json(true);
   if(name==='warpcore_mark_manual_review'){job.state='manual_review';return Response.json(true);}
   if(name==='warpcore_mark_published'){assert.equal(body.p_uri,`at://${did}/app.bsky.feed.post/${job.record_key}`);job.state='published';return Response.json(true);}assert.fail('Unexpected RPC '+name);
  }
  if(path==='/xrpc/com.atproto.repo.putRecord'){const body=JSON.parse(options.body),job=jobs.find(j=>j.record_key===body.rkey);assert.ok(job);assert.equal(body.repo,did);assert.equal(body.swapRecord,null);assert.equal(body.validate,true);assert.deepEqual(body.record,job.record_payload);assert.equal(job.state,'uncertain');records.set(body.rkey,structuredClone(body.record));return Response.json({uri:`at://${did}/app.bsky.feed.post/${body.rkey}`});}
  if(path==='/xrpc/com.atproto.repo.getRecord'){const rkey=url.searchParams.get('rkey'),value=records.get(rkey);assert.ok(value);return Response.json({uri:`at://${did}/app.bsky.feed.post/${rkey}`,value:wrongReadback?{...value,text:'Changed remote payload'}:value});}
  assert.fail('Unexpected synthetic destination '+url.origin+path);
 };
 return {jobs,events,add,fetcher,get reserved(){return reserved;},get publicationAttempts(){return publicationAttempts;}};
}
test('minute ticks skip empty auth, then publish exact persisted records with separate hourly guards',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetcher);assert.deepEqual(await(await handlePublish(request(),env)).json(),{processed:0,states:[]});assert.equal(f.reserved,0);
 for(let minute=1;minute<=5;minute++){const job=f.add(minute),snapshot=structuredClone(job.record_payload);const res=await handlePublish(request(),env);assert.equal(res.status,200);assert.deepEqual(await res.json(),{processed:1,states:['published']});assert.equal(job.state,'published');assert.deepEqual(job.record_payload,snapshot);assert.equal(f.reserved,minute);}
 f.add(6);assert.equal((await handlePublish(request(),env)).status,429);assert.equal(f.reserved,5);assert.equal(f.publicationAttempts,5);assert.equal(f.jobs[5].state,'prepared');assert.equal(f.events.filter(p=>p.endsWith('.createSession')).length,5);assert.equal(f.events.filter(p=>p.endsWith('.putRecord')).length,5);assert.equal(f.events.filter(p=>p.endsWith('.getRecord')).length,5);
});
test('minute publisher still refuses a changed readback and never repeats its write',async t=>{
 const f=fixture({wrongReadback:true});t.mock.method(globalThis,'fetch',f.fetcher);const job=f.add(1),snapshot=structuredClone(job.record_payload);assert.deepEqual(await(await handlePublish(request(),env)).json(),{processed:1,states:['manual_review']});assert.deepEqual(job.record_payload,snapshot);assert.deepEqual(await(await handlePublish(request(),env)).json(),{processed:0,states:[]});assert.equal(f.reserved,1);assert.equal(f.events.filter(p=>p.endsWith('.putRecord')).length,1);
});
