// Disposable PostgreSQL only. Public-source fixtures and fabricated model judgment.
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';
import {drainOne} from '../supabase/functions/news-curate/services.mjs';
const db=new PGlite(),q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const scalar=async(sql,args=[])=>(await q(sql,args))[0].value;
const admin=async fn=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role service_role');}};
const hash=s=>createHash('sha256').update(s).digest('hex');
const key=n=>n.toString(16).padStart(64,'0'),account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const load=async p=>db.exec(await fs.readFile(new URL(p,import.meta.url),'utf8'));
const history=()=>scalar('select public.warpcore_agent_history() as value');
const snapshot=story=>scalar('select public.warpcore_curator_snapshot($1) as value',[story]);
const issue=m=>scalar('select public.warpcore_agent_issue_receipt($1) as value',[m]);
const submit=id=>scalar('select public.warpcore_agent_submit($1) as value',[id]);
const receipt=id=>scalar('select public.warpcore_agent_receipt($1) as value',[id]);
const date=new Date().toISOString().slice(0,10);
async function seed(n){await admin(()=>q('select public.warpcore_ingest($1)',[[{uri:`fixture:${n}`,story_key:key(n),source_type:'rss',source_id:'official',actor:'official',text:'Public release',source_created_at:new Date().toISOString(),source_url:`https://example.com/${n}`,source_links:[`https://example.com/${n}`]}]]));return key(n);}
async function material(story){
 const s=await snapshot(story),h=await history();const body=`🦀 Official release ${date}: new capability is available.`;
 const quote=`Official release ${date}: new capability is available.`;
 return {version:'agent-verification-v1',agentId:'warpcore-news-agent-v1',runId:randomUUID(),storyKey:story,evidenceHash:s.evidence_hash,editorial:{summary:'A new capability is available.',whyItMatters:'The release expands practical access.',change:'New official release',political:false,evidenceIds:[s.evidence[0].id],verification:{checkedAt:new Date().toISOString(),sourceUrls:[s.evidence[0].url],reason:'Model-supported primary evidence with exact source quote.'}},model:'fixture/verification-model',policyVersion:'2026-11-14.1',requestProfileVersion:'fixture-v1',requestSha256:hash(randomUUID()),judgment:{method:'model-supported-primary-evidence',factsSupported:true,scopeApproved:true,meaningfulChange:true,dedupClear:true,checkedAt:new Date().toISOString(),claims:[{claim:`The release on ${date} adds a capability.`,evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),quote,quoteStart:2,quoteEnd:Array.from(body).length}],publicationDate:date,scopeReason:'Direct engineering relevance.',changeReason:'New release capability.',dedupReason:'No same event in complete history.',historyHash:h.snapshotHash},sources:[{evidenceId:s.evidence[0].id,url:s.evidence[0].url,contentSha256:hash(body),fetchedAt:new Date().toISOString(),body}]};
}
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const p of ['20261112145946_warpcore_review_base.sql','20261112164434_warpcore_source_provenance.sql','20261112175929_warpcore_curator_inbox.sql','20261112192659_warpcore_tid_record_keys.sql','20261113011427_warpcore_native_reposts.sql'])await load('../supabase/migrations/'+p);
 await load('../supabase/functions/news-agent/sql/shared-admission.sql');
 await load('../supabase/functions/news-agent/sql/agent-verification.sql');
 await db.exec('set role service_role');
 const k=await seed(1),m=await material(k),id=await issue(m);
 assert.equal(await issue(m),id,'Issue retries are immutable/idempotent');
 assert.equal((await receipt(id)).current,true);
 for(const mutate of [x=>x.agentId='fake-dot',x=>x.judgment.factsSupported=false,x=>x.judgment.historyHash='0'.repeat(64),x=>x.sources[0].contentSha256='0'.repeat(64),x=>x.judgment.claims[0].quoteStart=3,x=>x.judgment.claims[0].quote='invented',x=>x.sources[0].url='https://evil.example/',x=>x.judgment.checkedAt='2000-01-01T00:00:00Z']){
  const bad=structuredClone(m);bad.requestSha256=hash(randomUUID());mutate(bad);await assert.rejects(()=>issue(bad),/Invalid|Stale|stale|Unsupported/);
 }
 await assert.rejects(()=>issue({...m,model:'changed'}),/Immutable/);
 await assert.rejects(()=>q('update agent_verification.receipts set material=$1 where id=$2',[{},id]),/permission denied/);
 await admin(async()=>{await assert.rejects(()=>q('delete from agent_verification.receipts where id=$1',[id]),/immutable/);});
 const inbox=await submit(id);assert.equal(await submit(id),inbox);
 const row=(await q('select * from public.warpcore_curator_inbox where id=$1',[inbox]))[0];
 assert.equal(row.actor_kind,'agent');assert.equal(row.agent_id,m.agentId);assert.equal(row.dot_id,null);
 assert.equal((await receipt(id)).current,true,'Own inbox does not invalidate transfer');
 await assert.rejects(()=>q('update public.warpcore_curator_inbox set agent_id=$1 where id=$2',['forged',inbox]),/immutable/);
 const adapter={claim:async n=>JSON.parse(JSON.stringify(await q('select * from public.warpcore_curator_claim($1)',[n]))),snapshot,receipt,finalize:(r,p,j)=>scalar('select public.warpcore_curator_finalize($1,$2,$3,$4) as value',[r.id,r.lease_token,p,j]),fail:(r,reason)=>scalar('select public.warpcore_curator_fail($1,$2,$3) as value',[r.id,r.lease_token,reason])};
 assert.deepEqual(await drainOne({accountDid:account,dotId:'real-dot',agentId:m.agentId},adapter),[{state:'approved'}]);
 assert.equal((await q('select state from public.warpcore_publications where story_key=$1',[k]))[0].state,'prepared');
 const k2=await seed(2),m2=await material(k2),id2=await issue(m2);
 await admin(()=>q("update public.warpcore_candidates set text='Changed evidence' where story_key=$1",[k2]));
 assert.equal((await receipt(id2)).current,false);await assert.rejects(()=>submit(id2),/Stale/);
 const k3=await seed(3),m3=await material(k3),id3=await issue(m3),inbox3=await submit(id3);
 const lease3=(await q('select * from public.warpcore_curator_claim(1)'))[0];assert.equal(lease3.id,inbox3);
 // Another pending event changes the complete history and invalidates finalization.
 const k4=await seed(4),m4=await material(k4),id4=await issue(m4);await submit(id4);
 assert.equal((await receipt(id3)).current,false);
 assert.equal(await scalar('select public.warpcore_curator_finalize($1,$2,$3,$4) as value',[inbox3,lease3.lease_token,{},{}]),false);
 assert.equal((await q('select reason from public.warpcore_curator_inbox where id=$1',[inbox3]))[0].reason,'stale_verification_receipt');
 // Existing Dot submission API remains owner-only and preserves actor identity.
 const k5=await seed(5),m5=await material(k5);
 let dot;
 await admin(async()=>{dot=await scalar('select public.warpcore_curator_submit($1,$2,$3,$4,$5,$6) as value',[k5,m5.evidenceHash,m5.editorial,{factsVerified:true,meaningfulChange:true,scopeApproved:true},'real-dot',randomUUID()]);assert.equal((await q('select actor_kind from public.warpcore_curator_inbox where id=$1',[dot]))[0].actor_kind,'dot');});
 const finalizeExact=async row=>{
  const packet=await createReviewPacket({storyKey:row.story_key,evidence:row.evidence,editorial:row.editorial});
  const job={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(row.created_at).toISOString()),storyKey:row.story_key};
  return scalar('select public.warpcore_curator_finalize($1,$2,$3,$4) as value',[row.id,row.lease_token,packet,job]);
 };
 const dotLease=(await q('select * from public.warpcore_curator_claim(5)')).find(x=>x.id===dot);
 assert.equal(await finalizeExact(dotLease),true,'Dot finalizer still uses exact frozen contract');
 // Agent native repost preserves the exact URI/CID through the unchanged core.
 const nativeDid='did:plc:abcdefghijklmnopqrstuvwx',nativeUri=`at://${nativeDid}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53),nativeStory=key(6);
 await admin(()=>q('select public.warpcore_ingest($1)',[[{uri:'fixture:native',story_key:nativeStory,source_type:'bluesky',source_id:'official',actor:'official',text:'Official native release',source_created_at:new Date().toISOString(),source_url:'https://example.com/native',source_links:['https://example.com/native'],native_uri:nativeUri,native_url:'https://bsky.app/profile/'+nativeDid+'/post/3m3e4a2b22222',native_cid:cid,native_author_did:nativeDid}]]));
 const nm=await material(nativeStory);nm.editorial={mode:'repost',change:'Official release repost',political:false,evidenceIds:nm.editorial.evidenceIds,verification:nm.editorial.verification};
 const nativeOriginal={posts:[{uri:nativeUri,cid,author:{did:nativeDid},record:{$type:'app.bsky.feed.post',text:'Official release capability is available.',createdAt:new Date().toISOString()},labels:[]}]};
 const nativeBody=JSON.stringify(nativeOriginal),nativeHash=hash(nativeBody),logicalUrl='https://bsky.app/profile/'+nativeDid+'/post/3m3e4a2b22222';
 nm.sources=[{evidenceId:nm.editorial.evidenceIds[0],url:logicalUrl,contentSha256:nativeHash,fetchedAt:new Date().toISOString(),body:nativeBody,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(nativeUri),nativeUri,nativeCid:cid,nativeAuthorDid:nativeDid}];
 nm.editorial.verification.sourceUrls=[logicalUrl];
 nm.judgment.claims=[{claim:nm.editorial.change,quote:nativeOriginal.posts[0].record.text},{claim:date,quote:date}].map(c=>({...c,originalQuote:c.quote,evidenceId:nm.sources[0].evidenceId,url:logicalUrl,contentSha256:nativeHash,quoteStart:Array.from(nativeBody.slice(0,nativeBody.indexOf(c.quote))).length,quoteEnd:Array.from(nativeBody.slice(0,nativeBody.indexOf(c.quote)+c.quote.length)).length}));
 for(const mutate of [x=>x.judgment.claims[0].originalQuote='invented original quote',x=>x.sources[0].fetchedUrl='https://evil.example/',x=>x.sources[0].nativeAuthorDid='did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',x=>{const d=JSON.parse(x.sources[0].body);d.posts[0].cid='bafyre'+'b'.repeat(53);x.sources[0].body=JSON.stringify(d);x.sources[0].contentSha256=hash(x.sources[0].body);},x=>{const d=JSON.parse(x.sources[0].body);d.posts[0].labels=[{val:'warn'}];x.sources[0].body=JSON.stringify(d);x.sources[0].contentSha256=hash(x.sources[0].body);}]){
  const bad=structuredClone(nm);bad.requestSha256=hash(randomUUID());mutate(bad);await assert.rejects(()=>issue(bad),/Invalid native|Native quote outside/);
 }
 const nr=await issue(nm),ni=await submit(nr),nl=(await q('select * from public.warpcore_curator_claim(5)')).find(x=>x.id===ni);
 assert.equal(await finalizeExact(nl),true);
 const record=(await q('select record_payload from public.warpcore_publications where story_key=$1',[nativeStory]))[0].record_payload;
 assert.equal(record.$type,'app.bsky.feed.repost');assert.deepEqual(record.subject,{uri:nativeUri,cid});
 // API capture retains the logical approved release URL and exact raw JSON.
 const githubUrl='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1',githubStory=key(7);
 await seed(7);await admin(()=>q('update public.warpcore_candidates set source_url=$2,source_links=$3 where story_key=$1',[githubStory,githubUrl,[githubUrl]]));
 const gm=await material(githubStory),publishedAt=new Date().toISOString(),release={html_url:githubUrl,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:publishedAt,body:'🦀 Official release capability with exact raw JSON quote.'};
 const githubBody=JSON.stringify(release),githubHash=hash(githubBody),githubQuote='Official release capability';
 gm.sources=[{evidenceId:gm.editorial.evidenceIds[0],url:githubUrl,captureKind:'github-release-v1',fetchedUrl:'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1',contentSha256:githubHash,fetchedAt:new Date().toISOString(),body:githubBody}];gm.editorial.verification.sourceUrls=[githubUrl];gm.judgment.publicationDate=publishedAt.slice(0,10);
 gm.judgment.claims=[{claim:gm.editorial.change,evidenceId:gm.sources[0].evidenceId,url:githubUrl,contentSha256:githubHash,quote:githubQuote,quoteStart:Array.from(githubBody.slice(0,githubBody.indexOf(githubQuote))).length,quoteEnd:Array.from(githubBody.slice(0,githubBody.indexOf(githubQuote)+githubQuote.length)).length}];
 for(const mutate of [x=>x.sources[0].captureKind='github-release-v2',x=>x.sources[0].fetchedUrl='https://api.github.com/repos/evil/repo/releases/tags/v2026.47.1',x=>x.sources[0].fetchedUrl+='?token=private',x=>x.sources[0].contentSha256='0'.repeat(64),x=>x.judgment.claims[0].quoteStart++,x=>x.judgment.publicationDate=new Date(Date.now()-86400000).toISOString().slice(0,10),...['html_url','tag_name','draft','prerelease','published_at','body'].map(field=>x=>{const data=JSON.parse(x.sources[0].body);data[field]=({html_url:'https://evil.example/',tag_name:'wrong',draft:true,prerelease:'false',published_at:null,body:null})[field];x.sources[0].body=JSON.stringify(data);x.sources[0].contentSha256=hash(x.sources[0].body);})]){
  const bad=structuredClone(gm);bad.requestSha256=hash(randomUUID());mutate(bad);await assert.rejects(()=>issue(bad),/Invalid|Unsupported|GitHub/);
 }
 for(const patch of [{published_at:'2000-01-01T00:00:00Z'},{published_at:new Date(Date.now()+3600000).toISOString()},{published_at:publishedAt+'\n'},{published_at:publishedAt.replace(/T[0-9]{2}:/,'T24:')},{body:'x'.repeat(100000)}]){
  const bad=structuredClone(gm);bad.requestSha256=hash(randomUUID());bad.sources[0].body=JSON.stringify({...release,...patch});bad.sources[0].contentSha256=hash(bad.sources[0].body);await assert.rejects(()=>issue(bad),/GitHub/);
 }
 const gr=await issue(gm),gi=await submit(gr),gl=(await q('select * from public.warpcore_curator_claim(5)')).find(x=>x.id===gi);assert.equal(await finalizeExact(gl),true);
 assert.equal((await q('select record_payload from public.warpcore_publications where story_key=$1',[githubStory]))[0].record_payload.$type,'app.bsky.feed.post');
 // All seven code-reviewed repositories and literal + tags retain parity.
 const repos=['lemonade-sdk/lemonade','ROCm/TheRock','ggml-org/llama.cpp','vllm-project/vllm','ollama/ollama','ml-explore/mlx','anthropics/claude-code'];
 async function githubCase(repo,tag,n){const story=await seed(n),url=`https://github.com/${repo}/releases/tag/${tag}`;await admin(()=>q('update public.warpcore_candidates set source_url=$2,source_links=$3 where story_key=$1',[story,url,[url]]));const x=await material(story),data={...release,html_url:url,tag_name:tag},body=JSON.stringify(data),digest=hash(body),id=x.editorial.evidenceIds[0];x.sources=[{evidenceId:id,url,captureKind:'github-release-v1',fetchedUrl:`https://api.github.com/repos/${repo}/releases/tags/${tag}`,contentSha256:digest,fetchedAt:new Date().toISOString(),body}];x.judgment.claims=[{...gm.judgment.claims[0],evidenceId:id,url,contentSha256:digest,quoteStart:Array.from(body.slice(0,body.indexOf(githubQuote))).length,quoteEnd:Array.from(body.slice(0,body.indexOf(githubQuote)+githubQuote.length)).length}];return x;}
 for(const [n,repo] of repos.entries())assert.ok(await issue(await githubCase(repo,'v1.0+build',70+n)));
 await assert.rejects(()=>githubCase('unreviewed/repo','v1.0',80).then(issue),/GitHub capture/);
 await assert.rejects(()=>githubCase('lemonade-sdk/lemonade','.',81).then(issue),/GitHub capture/);
 // Complete history spans pages and conservatively retains old published rows.
 await admin(async()=>{
  await q("insert into public.warpcore_stories(story_key,status) select lpad(to_hex(n),64,'0'),'approved' from generate_series(100,159)n");
  await q(`insert into public.warpcore_publications(account_did,story_key,record_key,content_hash,record_payload,state,prepared_at)
   select $1,lpad(to_hex(n),64,'0'),public.warpcore_record_tid(lpad(to_hex(n),64,'0'),now()+n*interval '1 millisecond'),repeat('a',64),jsonb_build_object('$type','app.bsky.feed.post','text','Historical release '||n),'published','2000-01-01'::timestamptz from generate_series(100,159)n`,[account]);
 });
 const pages=[],seen=[];let cursor=null,fullHash;
 do{
  const page=await scalar('select public.warpcore_agent_history($1) as value',[cursor]);
  assert.ok(page.items.length<=50);assert.equal(page.historyCoverageMode,'all-published-plus-unresolved-v1');
  fullHash??=page.snapshotHash;assert.equal(page.snapshotHash,fullHash);pages.push(page);seen.push(...page.items.map(x=>x.historyKey));cursor=page.cursor;
  if(page.complete)break;
 }while(pages.length<10);
 assert.ok(pages.length>=2);assert.equal(pages.at(-1).complete,true);assert.equal(new Set(seen).size,seen.length);
 assert.ok(pages.flatMap(p=>p.items).some(x=>x.storyKey===key(100)),'Old publications remain conservatively visible');
 // Over time a parent may admit more than five stories, while actual pending capacity stays bounded.
 await db.exec('begin');await admin(()=>db.exec("update public.warpcore_curator_inbox set state='rejected',reason='fixture_release',completed_at=now() where state in ('pending','leased')"));const rollingRun=randomUUID();
 for(let n=201;n<=206;n++){const story=await seed(n),proposal=await material(story);proposal.runId=rollingRun;const proof=await issue(proposal),inbox=await submit(proof);assert.ok(inbox);await admin(()=>q("update public.warpcore_curator_inbox set state='rejected',reason='fixture_release',completed_at=now() where id=$1",[inbox]));}
 assert.equal((await admin(()=>q('select count(*)::int n from public.warpcore_curator_inbox where run_id=$1',[rollingRun])))[0].n,6,'No separate historical per-parent five-submission ceiling');await db.exec('rollback');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);for(const fn of [()=>issue(m),()=>submit(id),()=>receipt(id),history])await assert.rejects(fn,/permission denied/);}
 console.log('PASS: trusted-service receipt provenance/Unicode quotes, agent actor, idempotency/immutability, current snapshot/history rechecks, Dot coexistence and private grants; no posting');
}finally{await db.close();}
