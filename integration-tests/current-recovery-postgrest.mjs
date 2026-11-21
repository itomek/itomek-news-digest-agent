// Disposable real PostgreSQL/PostgREST; fabricated source/model judgment and AT remote.
// Installs the explicit sender/receipt migration subset below, not a production dump.
import assert from 'node:assert/strict';
import {createHmac,createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {Client} from 'pg';
import {createCuratorService} from '../supabase/functions/news-curate/services.mjs';
import {sendPrepared,reconcile} from '../supabase/functions/_shared/sender.mjs';
const database=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
assert.ok(['postgres:','postgresql:'].includes(database.protocol)&&database.hostname==='127.0.0.1'&&database.pathname==='/warpcore_test'&&!database.search&&!database.hash,'Dedicated disposable loopback database required');
const base=new URL(process.env.WARPCORE_TEST_POSTGREST_URL??'http://127.0.0.1:3000');
assert.equal(base.hostname,'127.0.0.1');
const secret=process.env.WARPCORE_TEST_JWT_SECRET;assert.ok(secret?.length>=32);
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const head=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'service_role',exp:Math.floor(Date.now()/1000)+600});
const token=head+'.'+createHmac('sha256',secret).update(head).digest('base64url');
const client=new Client({connectionString:database.href}),hash=s=>createHash('sha256').update(s).digest('hex');
const account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',did='did:plc:abcdefghijklmnopqrstuvwx',cid='bafyre'+'a'.repeat(53);
let requests=0,puts=0;
async function rpc(name,args={}){requests++;const r=await fetch(new URL('/rpc/'+name,base),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});assert.ok(r.ok,`${name}: ${r.status} ${await (!r.ok?r.text():Promise.resolve(''))}`);return r.json();}
const q=async(s,a=[])=>(await client.query(s,a)).rows;
const scalar=async(s,a=[])=>(await q(s,a))[0].v;
const load=async p=>client.query(await fs.readFile(new URL(p,import.meta.url),'utf8'));
try{
 await client.connect();assert.equal(await scalar("select to_regclass('public.warpcore_stories') is null v"),true,'Refuse existing database');
 await client.query('create role anon;create role authenticated;create role service_role bypassrls');
 for(const file of ['20261112145946_warpcore_review_base.sql','20261112153023_warpcore_login_guard.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112190000_warpcore_publication_hour_guard.sql','20261112192659_warpcore_tid_record_keys.sql','20261112201145_warpcore_hourly_batch_budget.sql','20261113011427_warpcore_native_reposts.sql','20261117162306_warpcore_login_batch_budget.sql'])await load('../supabase/migrations/'+file);
 for(const file of ['shared-admission.sql','agent-verification.sql'])await load('../supabase/functions/news-agent/sql/'+file);
 await load('../supabase/migrations/20261118180116_warpcore_drain_without_hourly_quota.sql');
 await client.query("notify pgrst, 'reload schema'");
 let ready=false;for(let i=0;i<60;i++){try{const r=await fetch(new URL('/rpc/warpcore_agent_history',base),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'PostgREST schema ready');
 const publicDenied=await fetch(new URL('/warpcore_curator_inbox',base));assert.ok([401,403,404].includes(publicDenied.status));
 async function prepare(n,{loseFinalize=false}={}){
  const story=n.toString(16).padStart(64,'0'),uri=`at://${did}/app.bsky.feed.post/3m3e4a2b2222${'234567abcdefghijklmnopqrstuvwxyz'[n]}`,url=`https://bsky.app/profile/${did}/post/3m3e4a2b2222${'234567abcdefghijklmnopqrstuvwxyz'[n]}`,createdAt=new Date().toISOString(),text='Synthetic native release '+n;
  await client.query('select public.warpcore_ingest($1)',[JSON.stringify([{uri,story_key:story,source_type:'bluesky',source_id:did,actor:did,text,source_created_at:createdAt,source_url:url,source_links:[url],native_uri:uri,native_url:url,native_cid:cid,native_author_did:did}])]);
  const snapshot=await rpc('warpcore_curator_snapshot',{p_story:story}),history=await rpc('warpcore_agent_history');
  const body=JSON.stringify({posts:[{uri,cid,author:{did},record:{$type:'app.bsky.feed.post',text,createdAt},labels:[]}]}),contentSha256=hash(body),evidenceId=snapshot.evidence[0].id;
  const claim=quote=>{const escaped=JSON.stringify(quote).slice(1,-1),quoteStart=body.indexOf(escaped);assert.ok(quoteStart>=0);return {claim:quote,evidenceId,url,contentSha256,quote:escaped,quoteStart,quoteEnd:quoteStart+escaped.length,originalQuote:quote};};
  const material={version:'agent-verification-v1',agentId:'warpcore-news-agent-v1',runId:randomUUID(),storyKey:story,evidenceHash:snapshot.evidence_hash,model:'synthetic/fixture',policyVersion:'fixture',requestProfileVersion:'fixture',requestSha256:hash('fixture-'+n),editorial:{mode:'repost',political:false,change:text,evidenceIds:[evidenceId],verification:{checkedAt:createdAt,sourceUrls:[url],reason:'Synthetic fixture with native source binding.'}},judgment:{method:'model-supported-primary-evidence',factsSupported:true,scopeApproved:true,meaningfulChange:true,dedupClear:true,checkedAt:createdAt,claims:[claim(text),claim(createdAt)],publicationDate:createdAt.slice(0,10),scopeReason:'Synthetic engineering release.',changeReason:'Synthetic new release.',dedupReason:'Synthetic unique release.',historyHash:history.snapshotHash},sources:[{evidenceId,url,contentSha256,body,fetchedAt:createdAt,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(uri),nativeUri:uri,nativeCid:cid,nativeAuthorDid:did}]};
  const receipt=await rpc('warpcore_agent_issue_receipt',{p_material:material});
  const inbox=await rpc('warpcore_agent_submit',{p_receipt:receipt});
  const duplicates=await Promise.all(Array.from({length:4},async()=>{const r=await fetch(new URL('/rpc/warpcore_agent_submit',base),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({p_receipt:receipt})});const body=await r.json();if(r.ok)assert.equal(body,inbox);else assert.equal(body.code,'55P03','Only explicit failfast admission contention may defer duplicate');return r.ok;}));assert.ok(duplicates.some(Boolean));
  assert.equal(await scalar('select count(*)::int v from public.warpcore_curator_inbox where verification_receipt_id=$1',[receipt]),1);
  let dropped=false;
  const localFetch=async(url,options)=>{assert.equal(url.hostname,'example.supabase.co');const response=await fetch(new URL(url.pathname.replace(/^\/rest\/v1/,'')+url.search,base),options);if(loseFinalize&&!dropped&&url.pathname.endsWith('/warpcore_curator_finalize')){assert.ok(response.ok);assert.equal(await response.json(),true);dropped=true;throw Error('Synthetic committed finalize response lost');}return response;};
  const curator=createCuratorService({projectUrl:'https://example.supabase.co',serviceKey:token,accountDid:account,dotId:'fixture-dot',agentId:'warpcore-news-agent-v1'},localFetch);
  assert.deepEqual(await curator.drain(),[{state:loseFinalize?'finalization_uncertain':'approved'}]);assert.deepEqual(await curator.drain(),[]);
  const row=(await q('select * from public.warpcore_curator_inbox where id=$1',[inbox]))[0];assert.equal(row.state,'processed');assert.equal(row.actor_kind,'agent');assert.equal(row.dot_id,null);assert.equal(row.verification_receipt_id,receipt);
  assert.equal(await scalar('select count(*)::int v from public.warpcore_publications where story_key=$1',[story]),1);
  const publication=(await q('select * from public.warpcore_publications where story_key=$1',[story]))[0];
  const job={accountDid:publication.account_did,storyKey:story,contentHash:publication.content_hash,recordKey:publication.record_key,record:publication.record_payload};
  assert.match(job.recordKey,/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);assert.deepEqual(job.record.subject,{uri,cid});assert.equal(job.record.$type,'app.bsky.feed.repost');
  const args=j=>({p_account:j.accountDid,p_story:j.storyKey,p_hash:j.contentHash,p_record:j.record});
  const db={claim:async j=>{const rows=await rpc('warpcore_claim_publication',args(j));return rows.length?{accountDid:rows[0].account_did,storyKey:rows[0].story_key,contentHash:rows[0].content_hash,recordKey:rows[0].record_key,record:rows[0].record_payload}:null;},uncertain:async j=>assert.equal(await rpc('warpcore_mark_uncertain',args(j)),true),checked:j=>rpc('warpcore_mark_checked',args(j)),manualReview:j=>rpc('warpcore_mark_manual_review',args(j)),published:(j,remote)=>rpc('warpcore_mark_published',{...args(j),p_uri:remote})};
  return {job,db,story};
 }
 const first=await prepare(1,{loseFinalize:true});let stored;
 const remote={verifySubject:async subject=>{assert.deepEqual(subject,first.job.record.subject);return true;},put:async(a,k,record,options)=>{puts++;assert.deepEqual(options,{swapRecord:null});assert.equal(await scalar('select state v from public.warpcore_publications where story_key=$1',[first.story]),'uncertain','Durable uncertainty precedes remote write');stored={uri:`at://${a}/app.bsky.feed.repost/${k}`,record:structuredClone(record)};throw Error('Synthetic remote committed, response lost');},get:async(a,k,collection)=>{assert.equal(collection,'app.bsky.feed.repost');assert.equal(k,first.job.recordKey);return structuredClone(stored);}};
 assert.deepEqual(await sendPrepared(first.job,first.db,remote,{enabled:true,accountDid:account}),{state:'uncertain'});
 assert.deepEqual(await sendPrepared(first.job,first.db,remote,{enabled:true,accountDid:account}),{state:'not_claimed'});assert.equal(puts,1,'Lost send response cannot resend');
 assert.equal((await reconcile(first.job,first.db,remote)).state,'published');assert.equal(puts,1);assert.equal(await scalar('select state v from public.warpcore_publications where story_key=$1',[first.story]),'published');
 const second=await prepare(2);const wrong={verifySubject:async()=>false,put:async()=>{puts++;throw Error('Must not send changed native subject');}};
 assert.deepEqual(await sendPrepared(second.job,second.db,wrong,{enabled:true,accountDid:account}),{state:'manual_review'});assert.equal(puts,1);
 const third=await prepare(3);assert.ok(await third.db.claim(third.job));await third.db.uncertain(third.job);
 assert.deepEqual(await reconcile(third.job,third.db,{get:async()=>({uri:`at://${account}/app.bsky.feed.repost/${third.job.recordKey}`,record:{...third.job.record,subject:{...third.job.record.subject,cid:'bafyre'+'b'.repeat(53)}}})}),{state:'manual_review'});assert.equal(puts,1);
 for(const item of [second,third])assert.equal(await scalar('select state v from public.warpcore_publications where story_key=$1',[item.story]),'manual_review');
 // Repeat a bounded batch if the real UTC hour rolls over during the HTTP
 // calls. Never freeze the production clock or weaken the six-in-one-hour proof.
 const hour=()=>scalar('select floor(extract(epoch from clock_timestamp())/3600)::bigint::text v');
 let sixClaims=false,nextId=4;
 for(let round=0;round<2&&!sixClaims;round++){
  const started=await hour();
  for(let i=0;i<6;i++){const next=await prepare(nextId++);assert.ok(await next.db.claim(next.job));await next.db.uncertain(next.job);assert.equal(await next.db.published(next.job,`at://${account}/app.bsky.feed.repost/${next.job.recordKey}`),true);}
  sixClaims=started===await hour();
 }
 assert.ok(sixClaims,'Six claims must complete within one actual hour');
 assert.ok(await scalar('select attempts>=6 v from public.warpcore_publication_slots where account_did=$1',[account]));
 let sixLogins=false;
 for(let round=0;round<2&&!sixLogins;round++){
  const started=await hour();
  for(let i=0;i<6;i++)assert.equal(await rpc('warpcore_reserve_login',{p_account:account}),true);
  sixLogins=started===await hour();
 }
 assert.ok(sixLogins,'Six logins must complete within one actual hour');
 assert.ok(await scalar('select attempts>=6 v from public.warpcore_login_slots where account_did=$1',[account]));
 assert.equal(await scalar('select count(*)::int v from public.warpcore_publications'),nextId-1);
 // The retained five-pending limit is independent of the removed hourly quota.
 for(let n=20;n<=22;n++)await prepare(n);
 await assert.rejects(()=>prepare(23),/Combined pending limit/);
 assert.equal(await scalar("select count(*)::int v from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')"),5);
 console.log(`PASS: real PostgreSQL/PostgREST (${requests} RPCs), committed/lost curator finalize creates one publication; committed/lost fake native send cannot resend, exact readback reconciles; changed native source and readback CID fail to manual review; concurrent duplicate agent submissions stay unique; six same-hour logins and at least six claims succeed while sixth pending is denied; fake remote puts=${puts}, live sends=0`);
}finally{await client.end();}
