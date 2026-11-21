import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runVerificationInvocation,VERIFICATION_RESERVATION_CREDITS} from './verification-runtime.mjs';
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,story='a'.repeat(64),evidenceHash='b'.repeat(64),historyHash='c'.repeat(64),url='https://ir.amd.com/fixture-release';
const cfg={enabled:true,apiKey:'synthetic-not-a-credential',model:'openai/gpt-oss-120b',allowedModels:['openai/gpt-oss-120b'],expectedProvider:'Cerebras',maxOutputTokens:4096,maxCostCredits:VERIFICATION_RESERVATION_CREDITS,allowedSourceHosts:['ir.amd.com']};
const evidence={id:'rss:release',url,text:'Discovery excerpt.',sourceType:'rss',visibility:'public',sourceLinks:[url],nativeUri:null,nativeUrl:null};
const hash=s=>createHash('sha256').update(s).digest('hex');
function wireResult(result,input){
 if(result?.action!=='approve'||!Array.isArray(result.claims))return result;
 const {claims,...out}=result,fields=result.editorial?.mode==='repost'?['change','publicationDate']:['summary','whyItMatters','change','publicationDate'];
 return {...out,supports:Object.fromEntries(fields.map(field=>{const c=claims.find(c=>c.claim===(field==='publicationDate'?result.publicationDate:result.editorial[field])),source=input.sources.find(s=>s.evidenceId===c?.evidenceId);const refs=source?.quoteReferences??source?.bodyChunks;const ref=refs?.find(r=>source.quoteReferences?(field==='publicationDate'?r.id.endsWith('-created-at'):r.id.endsWith('-original-text')):r.text.includes(c?.quote));return [field,ref?.id??'unknown-quote'];}))};
}
function fixture(){
 const events=[];let charged=false,reservedHash,material;
 const current=new Date().toISOString(),date=current.slice(0,10),body=`Official release ${date}. The new release expands access. Developers gain practical capabilities. A new supported capability was released.`;
 const result={action:'approve',editorial:{political:false,summary:'The new release expands access.',whyItMatters:'Developers gain practical capabilities.',change:'A new supported capability was released.',evidenceIds:[evidence.id]},publicationDate:date,scopeReason:'Direct stated engineering interest.',changeReason:'A new capability.',dedupReason:'Different from every historic event.',claims:[]};
 for(const claim of [result.editorial.summary,result.editorial.whyItMatters,result.editorial.change,date])result.claims.push({claim,evidenceId:evidence.id,url,contentSha256:hash(body),quote:body});
 const state={events,config:structuredClone(cfg),now:()=>current,get material(){return material;},result};
 state.rpc=async(name,args)=>{
  events.push({name,args});
  if(name==='warpcore_verification_claim')return charged?null:{jobId:id(1),rankingRunId:id(2),storyKey:story,lease:id(3)};
  if(name==='warpcore_curator_snapshot')return {story_key:story,evidence_hash:evidenceHash,evidence:[{...evidence,privateIgnored:'never-in-prompt'}]};
  if(name==='warpcore_agent_history')return {snapshotHash:historyHash,historyCoverageMode:'all-published-plus-unresolved-v1',cursor:null,items:[],complete:true};
  if(name==='warpcore_verification_reserve'){reservedHash=args.p_hash;assert.equal(args.p_max,approvedRuntimeModel(state.config.model).maxCostCredits);return id(4);}
  if(name==='warpcore_verification_dispatch'){charged=true;return true;}
  if(name==='warpcore_verification_settle')return true;
  if(name==='warpcore_agent_issue_receipt'){material=args.p_material;assert.equal(material.requestSha256,reservedHash);return id(5);}
  if(name==='warpcore_verification_finish')return true;
  if(name==='warpcore_verification_handoff')return id(6);
  throw Error('Unexpected RPC');
 };
 state.evidenceFetcher=async(request,options)=>{events.push({name:'source_get'});assert.equal(request,url);assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);return new Response(body,{headers:{'content-type':'text/plain'}});};
 state.modelFetcher=async(request,options)=>{
  events.push({name:'model_post'});assert.equal(request,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer '+cfg.apiKey);
  assert.equal(hash(options.body),reservedHash);const parsed=JSON.parse(options.body),input=JSON.parse(parsed.messages[1].content);state.projectedInput=input;assert.equal(input.evidence[0].privateIgnored,undefined);assert.equal(JSON.stringify(input.history).includes('never-in-prompt'),false);assert.equal(parsed.stream,false);
  return Response.json({id:'fixture-generation',model:state.config.model,provider:state.config.expectedProvider,usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300,cost:.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({result:wireResult(state.result,input)})}}]});
 };
 return state;
}
const run=f=>runVerificationInvocation(f);
test('one paid verification settles then creates immutable receipt and submits once; restart never rescores',async()=>{
 const f=fixture(),out=await run(f);assert.equal(out.status,'submitted');assert.equal(out.publishingEnabled,false);
 assert.deepEqual(f.events.map(e=>e.name),['warpcore_verification_claim','warpcore_curator_snapshot','warpcore_agent_history','source_get','warpcore_verification_reserve','warpcore_verification_dispatch','model_post','warpcore_verification_settle','warpcore_agent_issue_receipt','warpcore_verification_finish','warpcore_verification_handoff']);
 assert.equal(f.material.agentId,'warpcore-news-agent-v1');assert.equal(f.material.runId,id(2));assert.equal(f.material.judgment.method,'model-supported-primary-evidence');assert.ok(Number.isInteger(f.material.judgment.claims[0].quoteStart));
 assert.equal((await run(f)).status,'idle');assert.equal(f.events.filter(e=>e.name==='model_post').length,1);
});
test('disabled and insufficient configured envelope never claim or call model',async()=>{
 for(const patch of [{enabled:false},{maxCostCredits:.01},{apiKey:''},{expectedProvider:'Other'}]){const f=fixture();Object.assign(f.config,patch);await run(f);assert.equal(f.events.length,0);}
});
test('source acquisition failure defers without reserving or model inference',async()=>{
 const f=fixture();f.evidenceFetcher=async()=>{throw Error('failure');};assert.equal((await run(f)).status,'deferred');assert.equal(f.events.at(-1).args.p_status,'deferred');assert.equal(f.events.some(e=>e.name==='warpcore_verification_reserve'),false);
});
test('invalid native identity defers before model inference',async()=>{
 const f=fixture(),rpc=f.rpc;f.rpc=async(name,a)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[{...evidence,sourceType:'bluesky'}]}:rpc(name,a);
 assert.equal((await run(f)).reason,'evidence_or_history_unavailable');assert.equal(f.events.some(e=>e.name==='model_post'),false);
});
test('complete paged history is public projected and a changed full hash defers',async()=>{
 for(const changed of [false,true]){
  const f=fixture(),rpc=f.rpc;let pages=0;f.rpc=async(name,a)=>{
   if(name!=='warpcore_agent_history')return rpc(name,a);pages++;
   return {snapshotHash:pages===2&&changed?'d'.repeat(64):historyHash,historyCoverageMode:'all-published-plus-unresolved-v1',cursor:pages===1?'p:first':null,complete:pages===2,items:pages===1?[{kind:'publication',storyKey:'e'.repeat(64),record:{$type:'app.bsky.feed.post',text:'A different old event.',secret:'never-in-prompt'},candidateContext:[],privateMetadata:{token:'never-in-prompt'}}]:[]};
  };
  assert.equal((await run(f)).status,changed?'deferred':'submitted');assert.equal(pages,2);
  if(changed)assert.equal(f.events.some(e=>e.name==='model_post'),false);
 }
});
test('unknown model outcome retains uncertain hold and does not finish or submit',async()=>{
 const f=fixture();f.modelFetcher=async()=>{throw Error('private transport detail');};const out=await run(f);assert.equal(out.status,'uncertain');
 const settle=f.events.find(e=>e.name==='warpcore_verification_settle');assert.equal(settle.args.p_status,'uncertain');assert.equal(settle.args.p_cost,null);
 assert.equal(f.events.some(e=>e.name==='warpcore_verification_finish'),false);assert.equal(f.events.some(e=>e.name==='warpcore_verification_handoff'),false);
 assert.equal((await run(f)).status,'idle');
});
test('known billed invalid schema records real audit with validationError and defers',async()=>{
 const f=fixture();f.result={action:'approve',invented:true};assert.equal((await run(f)).status,'deferred');
 const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(audit.p_status,'settled');assert.equal(audit.p_cost,.01);assert.equal(audit.p_audit.validationError,'invalid_verification_schema');assert.equal(audit.p_audit.generationId,'fixture-generation');assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
});
test('billed unsupported quote settles real cost but cannot issue a receipt',async()=>{
 const f=fixture();f.result.claims[0].quote='invented';assert.equal((await run(f)).reason,'billed_invalid_completion');assert.equal(f.events.find(e=>e.name==='warpcore_verification_settle').args.p_cost,.01);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
});
test('lost reservation, dispatch, settlement, receipt, finish or submission responses never retry downstream',async()=>{
 for(const lost of ['warpcore_verification_reserve','warpcore_verification_dispatch','warpcore_verification_settle','warpcore_agent_issue_receipt','warpcore_verification_finish','warpcore_verification_handoff']){
  const f=fixture(),rpc=f.rpc;f.rpc=async(name,a)=>{const out=await rpc(name,a);if(name===lost)throw Error('response lost');return out;};
  assert.equal((await run(f)).status,'uncertain');assert.equal(f.events.at(-1).name,lost);assert.equal(f.events.filter(e=>e.name==='model_post').length,lost==='warpcore_verification_reserve'||lost==='warpcore_verification_dispatch'?0:1);
 }
});

test('nested metadata disguised as a public history field fails before paid inference',async()=>{
 const f=fixture(),rpc=f.rpc;f.rpc=async(name,a)=>name==='warpcore_agent_history'?{snapshotHash:historyHash,historyCoverageMode:'all-published-plus-unresolved-v1',cursor:null,complete:true,items:[{kind:'inbox',storyKey:'e'.repeat(64),editorial:{summary:{credential:'must-not-forward'}},candidateContext:[]}]}:rpc(name,a);
 assert.equal((await run(f)).status,'deferred');assert.equal(f.events.some(e=>e.name==='model_post'),false);
});

test('native original uses actual pinned public lookup and the same paid ledger/handoff with exact subject',async()=>{
 const f=fixture(),rpc=f.rpc,did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53),nativeUrl=`https://bsky.app/profile/${did}/post/3m3e4a2b22222`;
 const createdAt=new Date().toISOString(),date=createdAt.slice(0,10),recordText='An official capability is available.';
 const native={...evidence,url:nativeUrl,nativeUrl,nativeUri:uri,nativeCid:cid,nativeAuthorDid:did,sourceType:'bluesky',sourceLinks:[nativeUrl]},body=JSON.stringify({posts:[{uri,cid,author:{did},record:{$type:'app.bsky.feed.post',text:recordText,createdAt},labels:[]}]});
 f.rpc=async(name,a)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[native]}:rpc(name,a);
 f.evidenceFetcher=async(target,o)=>{f.events.push({name:'native_get'});assert.equal(target,'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(uri));assert.equal(o.headers.Authorization,undefined);return new Response(body,{headers:{'content-type':'application/json'}});};
 f.result={action:'approve',editorial:{mode:'repost',political:false,change:recordText,evidenceIds:[native.id]},publicationDate:date,scopeReason:'Engineering relevance.',changeReason:'New official capability.',dedupReason:'No duplicate event.',claims:[{claim:recordText,quote:recordText},{claim:date,quote:date}].map(c=>({...c,evidenceId:native.id,url:nativeUrl,contentSha256:hash(body)}))};
 assert.equal((await run(f)).status,'submitted');assert.equal(f.events.filter(e=>e.name==='model_post').length,1);assert.equal(f.material.editorial.mode,'repost');assert.equal(f.material.editorial.summary,undefined);assert.equal(f.material.sources[0].nativeUri,uri);assert.equal(f.material.sources[0].nativeCid,cid);assert.equal(f.material.sources[0].nativeAuthorDid,did);assert.equal(f.material.sources[0].body,body);assert.equal(f.events.at(-1).name,'warpcore_verification_handoff');
});
test('recovered verified receipt performs only durable handoff and never repeats paid work',async()=>{
 for(const inbox of [id(6),null]){
  const f=fixture();f.rpc=async(name,args)=>{f.events.push({name,args});if(name==='warpcore_verification_claim')return {jobId:id(1),rankingRunId:id(2),storyKey:story,lease:id(3),handoffReceiptId:id(5)};assert.equal(name,'warpcore_verification_handoff');return inbox;};
  assert.equal((await run(f)).status,inbox?'submitted':'deferred');assert.deepEqual(f.events.map(e=>e.name),['warpcore_verification_claim','warpcore_verification_handoff']);
 }
});
test('verification HTTP status is durably bounded while unknown costs keep hold/no replay',async()=>{
 for(const status of [400,402,429,500,503]){const f=fixture();let calls=0;f.modelFetcher=async()=>{calls++;return new Response('private body '+cfg.apiKey,{status});};assert.equal((await run(f)).status,'uncertain');const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(audit.p_cost,null);assert.deepEqual(audit.p_audit,{errorCode:'http_failure',diagnostic:{httpStatus:status}});assert.equal(JSON.stringify(audit).includes(cfg.apiKey),false);assert.equal((await run(f)).status,'idle');assert.equal(calls,1);}
});
test('known invalid generation retains its ID while malformed provider text is omitted from paid audit',async()=>{
 const f=fixture(),base=f.modelFetcher;f.modelFetcher=async(...args)=>{const p=await(await base(...args)).json();p.provider='Cerebras\nprivate-provider';return Response.json(p);};assert.equal((await run(f)).status,'deferred');const settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settled.p_cost,.01);assert.equal(settled.p_status,'settled');assert.equal(settled.p_audit.errorCode,'invalid_completion');assert.deepEqual(settled.p_audit.diagnostic,{generationId:'fixture-generation',model:cfg.model});assert.equal(JSON.stringify(settled).includes('private-provider'),false);
});
test('credentials echoed into otherwise bounded identity fields cannot enter known-error audit',async()=>{
 for(const field of ['id','provider']){const f=fixture(),base=f.modelFetcher;f.modelFetcher=async(...args)=>{const p=await(await base(...args)).json();p[field]=cfg.apiKey;p.choices[0].message.content='{';return Response.json(p);};assert.equal((await run(f)).status,'deferred');const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(audit.p_cost,.01);assert.equal(JSON.stringify(audit).includes(cfg.apiKey),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);}
});

test('reviewed Gemma runtime reserves only its code-owned cap and records the selected actual model',async()=>{for(const model of ['google/gemma-4-26b-a4b-it']){const approved=approvedRuntimeModel(model),f=fixture();Object.assign(f.config,{model,allowedModels:[model],expectedProvider:approved.provider,maxCostCredits:approved.maxCostCredits});assert.equal((await run(f)).status,'submitted');const reserve=f.events.find(x=>x.name==='warpcore_verification_reserve').args;assert.equal(reserve.p_max,approved.maxCostCredits);assert.equal(reserve.p_metadata.model,model);assert.equal(reserve.p_metadata.expectedProvider,'PrimeIntellect');assert.equal(f.material.model,model);const bad=fixture();Object.assign(bad.config,{model,allowedModels:[model],expectedProvider:'Cerebras',maxCostCredits:approved.maxCostCredits});assert.equal((await run(bad)).reason,'invalid_configuration');assert.equal(bad.events.length,0);}});
test('verification429 diagnostics survive durable uncertain settlement without paid replay',async()=>{
 const f=fixture();let calls=0;f.modelFetcher=async()=>{calls++;return Response.json({error:{code:429,message:'private text',metadata:{provider_code:'rate_limited',error_type:'rate_limit_exceeded',provider_name:'DeepInfra',limit_source:'upstream_provider_shared_pool'}}},{status:429,headers:{'retry-after':'30','x-request-id':'req-verify_123'}});};
 assert.equal((await run(f)).status,'uncertain');const settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settlement.p_cost,null);assert.equal(settlement.p_status,'uncertain');assert.deepEqual(settlement.p_audit,{errorCode:'http_failure',diagnostic:{httpStatus:429,providerErrorCode:'rate_limited',providerErrorType:'rate_limit_exceeded',errorProvider:'DeepInfra',limitSource:'upstream_provider_shared_pool',retryAfterSeconds:30,requestId:'req-verify_123'}});assert.equal(JSON.stringify(settlement).includes('private text'),false);assert.equal((await run(f)).status,'idle');assert.equal(calls,1);
});
test('parsed verifier result is privately retained before semantic validation and cannot authorize a receipt',async()=>{
 const f=fixture();f.result.claims[0].quote='unsupported quoted statement';const out=await run(f);const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;
 assert.equal(audit.p_cost,.01);assert.equal(audit.p_audit.validationError,'invalid_verification_schema');assert.equal(out.reason,'billed_invalid_completion');assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_verification_finish'));
});
test('optional archival rejection cannot strand known billed usage or leak a credential-bearing model result',async()=>{
 for(const reason of ['x'.repeat(1001),'Model echoed '+cfg.apiKey]){
 const f=fixture();f.result={action:'defer',reason};const out=await run(f);const settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;
 assert.equal(settled.p_status,'settled');assert.equal(settled.p_cost,.01);assert.equal(Object.hasOwn(settled.p_audit,'result'),false);assert.equal(JSON.stringify(settled).includes(cfg.apiKey),false);assert.equal(out.status,'deferred');assert.equal(JSON.stringify(out).includes(reason),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
 }
});
test('NUL and lone-surrogate model output cannot block settlement of known usage',async()=>{
 for(const reason of ['nul\u0000text','lone\ud800high','lone\udffflow']){
 const f=fixture();f.result={action:'defer',reason};const originalRpc=f.rpc;
 f.rpc=async(name,args)=>{if(name==='warpcore_verification_settle')assert.equal(Object.hasOwn(args.p_audit,'result'),false,'PostgreSQL-incompatible result must be omitted before RPC');return originalRpc(name,args);};
 const out=await run(f);assert.equal(out.status,'deferred');assert.equal(out.reason,'unsupported_verification');const settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settlement.p_status,'settled');assert.equal(settlement.p_cost,.01);assert.equal(Object.hasOwn(settlement.p_audit,'result'),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
 }
});
test('unsupported non-native provenance defers before any acquisition, reservation or model call',async()=>{
 const f=fixture(),base=f.rpc;f.config.allowedSourceHosts=['example.com'];f.rpc=async(name,args)=>{const result=await base(name,args);if(name==='warpcore_curator_snapshot')result.evidence=result.evidence.map(e=>({...e,url:'https://example.com/354657/fixture',sourceLinks:[]}));return result;};
 const out=await run(f);assert.equal(out.reason,'unapproved_primary_source');assert.equal(f.events.some(e=>['model_post','warpcore_verification_reserve','source_get'].includes(e.name)),false);
});
test('pure publishing preflight rejects editorial that would be rejected as a raw repost, after cost settlement',async()=>{
 const f=fixture(),old=f.result.editorial.summary;f.result.editorial.summary=evidence.text;f.result.claims.find(c=>c.claim===old).claim=evidence.text;
 const out=await run(f);assert.equal(out.reason,'verification_post_unpublishable');assert.equal(f.events.find(e=>e.name==='warpcore_verification_settle').args.p_cost,.01);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
});
test('V3 short quote references are archived before semantic validation and trusted prefix only enters normalized material',async()=>{
 const f=fixture();assert.equal((await run(f)).status,'submitted');const settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;
 assert.equal(settlement.p_cost,.01);assert.equal(typeof settlement.p_audit.result.supports.summary,'string');assert.match(settlement.p_audit.result.supports.summary,/^source-1-chunk-[0-9]{4}$/);assert.equal(settlement.p_audit.result.editorial.summary,f.result.editorial.summary);assert.equal(f.material.editorial.summary,'AMD reports: '+f.result.editorial.summary);assert.equal(f.material.judgment.claims[0].claim,f.material.editorial.summary);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_agent_issue_receipt'));
});
test('APPROVE NUL and lone-surrogate editorial/reasons settle known usage then defer before receipt RPC',async()=>{
 for(const invalid of ['bad\u0000text','bad\ud800text','bad\udffftext'])for(const field of ['summary','whyItMatters','change','scopeReason','changeReason','dedupReason']){
 const f=fixture();if(Object.hasOwn(f.result.editorial,field)){const old=f.result.editorial[field];f.result.editorial[field]=invalid;f.result.claims.find(c=>c.claim===old).claim=invalid;}else f.result[field]=invalid;
 const out=await run(f);assert.equal(out.status,'deferred');assert.equal(out.reason,'unsupported_verification');const settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settled.p_status,'settled');assert.equal(settled.p_cost,.01);assert.equal(Object.hasOwn(settled.p_audit,'result'),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.equal(f.events.at(-1).name,'warpcore_verification_finish');
 }
});
test('wire-valid oversized text and empty evidence IDs retain private result and known settlement before semantic deferral',async()=>{
 for(const invalid of ['oversized','empty_ids']){
 const f=fixture();if(invalid==='oversized'){const previous=f.result.editorial.summary;f.result.editorial.summary='x'.repeat(500);f.result.claims.find(c=>c.claim===previous).claim=f.result.editorial.summary;}else f.result.editorial.evidenceIds=[];
 const out=await run(f),settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(out.status,'deferred');assert.equal(out.reason,'unsupported_verification');assert.equal(settlement.p_status,'settled');assert.equal(settlement.p_cost,.01);assert.deepEqual(settlement.p_audit.result,wireResult(f.result,f.projectedInput));assert.equal(settlement.p_audit.validationError,undefined);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_verification_finish'));
 }
});
test('Cerebras bounded generic capture preserves full108KB and120KB without truncation',async()=>{
 for(const bytes of [108006,120000]){
  const f=fixture(),base=f.evidenceFetcher;let raw;
  f.evidenceFetcher=async(...args)=>{raw=(await(await base(...args)).text()).padEnd(bytes,' ');return new Response(raw,{headers:{'content-type':'text/plain'}});};
  assert.equal((await run(f)).status,'submitted');assert.equal(new TextEncoder().encode(f.material.sources[0].body).length,bytes);assert.equal(f.material.sources[0].body,raw);assert.equal(f.material.sources[0].contentSha256,hash(raw));assert.equal(f.projectedInput.sources[0].bodyChunks.map(c=>c.text).join(''),raw);assert.equal(f.events.filter(e=>e.name==='model_post').length,1);
 }
});
test('Cerebras source capacity guard defers over120KB before any paid reservation without truncation',async()=>{
 const f=fixture();f.evidenceFetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(120001)));controller.close();}}),{headers:{'content-type':'text/plain'}});
 const out=await run(f);assert.equal(out.status,'deferred');assert.equal(out.reason,'evidence_or_history_unavailable');assert.equal(f.events.some(e=>['model_post','warpcore_verification_reserve','warpcore_verification_dispatch'].includes(e.name)),false);assert.equal(f.events.at(-1).name,'warpcore_verification_finish');
});

test('native quote-ID prose retains known paid result then defers without issuing receipt',async()=>{
 const f=fixture(),now=f.now(),did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53),nativeUrl=`https://bsky.app/profile/${did}/post/3m3e4a2b22222`;
 const item={id:'native:1',url:nativeUrl,nativeUrl,nativeUri:uri,nativeCid:cid,nativeAuthorDid:did,text:'Official new capability.',sourceType:'bluesky',visibility:'public',sourceLinks:[nativeUrl]};
 const original={posts:[{uri,cid,author:{did},record:{$type:'app.bsky.feed.post',text:item.text,createdAt:now},labels:[]}]};
 const baseRpc=f.rpc;f.rpc=async(name,args)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[item]}:baseRpc(name,args);
 f.evidenceFetcher=async()=>Response.json(original);
 f.result={action:'approve',editorial:{mode:'repost',political:false,change:'source-1-original-text',evidenceIds:[item.id]},supports:{change:'source-1-original-text',publicationDate:'source-1-created-at'},publicationDate:now.slice(0,10),scopeReason:'Engineering.',changeReason:'New capability.',dedupReason:'No duplicate.'};
 const out=await run(f),settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;
 assert.equal(out.status,'deferred');assert.equal(out.reason,'unsupported_verification');assert.equal(settled.p_status,'settled');assert.equal(settled.p_cost,.01);assert.deepEqual(settled.p_audit.result,f.result);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_verification_finish'));
});
test('reviewed GitHub release uses full fixed API capture and trusted date before paid verification',async()=>{
 const f=fixture(),releaseUrl='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1',item={...evidence,url:releaseUrl,sourceLinks:[releaseUrl]},base=f.rpc;
 f.config.allowedSourceHosts=['github.com'];f.rpc=async(name,args)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[item]}:base(name,args);
 const data={html_url:releaseUrl,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:f.now(),body:'The new release expands access. Developers gain practical capabilities. A new supported capability was released.'};
 f.evidenceFetcher=async(u,o)=>{assert.equal(u,'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1');assert.equal(o.credentials,'omit');return Response.json(data);};
 f.result={...f.result,supports:{summary:'source-1-chunk-0001',whyItMatters:'source-1-chunk-0001',change:'source-1-chunk-0001',publicationDate:'source-1-chunk-0001'}};delete f.result.claims;
 const baseModel=f.modelFetcher;f.modelFetcher=async(...args)=>{const source=JSON.parse(JSON.parse(args[1].body).messages[1].content).sources[0];f.result.supports=Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,source.quoteRoles[k==='publicationDate'?'publicationDate':'content'][0]]));return baseModel(...args);};
 assert.equal((await run(f)).status,'submitted');assert.equal(f.material.sources[0].captureKind,'github-release-v1');assert.equal(f.material.sources[0].url,releaseUrl);assert.equal(f.material.sources[0].body,JSON.stringify(data));assert.equal(f.material.judgment.publicationDate,data.published_at.slice(0,10));
 const rejected=fixture();rejected.config.allowedSourceHosts=['github.com'];const rpc=rejected.rpc;rejected.rpc=async(name,args)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[item]}:rpc(name,args);rejected.evidenceFetcher=async()=>Response.json({...data,draft:true});assert.equal((await run(rejected)).reason,'evidence_or_history_unavailable');assert.equal(rejected.events.some(e=>e.name==='warpcore_verification_reserve'||e.name==='model_post'),false);
});
test('provider source capacity preserves full150KB for Gemma and refuses it before paid Cerebras work',async()=>{
 for(const model of ['google/gemma-4-26b-a4b-it','openai/gpt-oss-120b']){
  const f=fixture(),approved=approvedRuntimeModel(model),base=f.evidenceFetcher;
  Object.assign(f.config,{model,allowedModels:[model],expectedProvider:approved.provider,maxCostCredits:approved.maxCostCredits});
  let raw;f.evidenceFetcher=async(...args)=>{raw=(await(await base(...args)).text()).padEnd(150000,' ');return new Response(raw,{headers:{'content-type':'text/plain'}});};
  const out=await run(f);
  if(approved.provider==='Cerebras'){assert.equal(out.reason,'evidence_or_history_unavailable');assert.equal(f.events.some(e=>['model_post','warpcore_verification_reserve','warpcore_verification_dispatch'].includes(e.name)),false);}
  else{assert.equal(out.status,'submitted');assert.equal(f.material.sources[0].body,raw);assert.equal(f.material.sources[0].contentSha256,hash(raw));assert.equal(new TextEncoder().encode(raw).length,150000);assert.equal(f.projectedInput.sources[0].bodyChunks.map(c=>c.text).join(''),raw);assert.equal(f.events.filter(e=>e.name==='model_post').length,1);}
 }
});
test('Cerebras and Gemma ordinary-source allowances leave GitHub API hard100KB before paid work',async()=>{
 for(const model of ['openai/gpt-oss-120b','google/gemma-4-26b-a4b-it']){
 const f=fixture(),approved=approvedRuntimeModel(model),releaseUrl='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1',item={...evidence,url:releaseUrl,sourceLinks:[releaseUrl]},base=f.rpc;
 Object.assign(f.config,{model,allowedModels:[model],expectedProvider:approved.provider,maxCostCredits:approved.maxCostCredits,allowedSourceHosts:['github.com']});f.rpc=async(name,args)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[item]}:base(name,args);
 f.evidenceFetcher=async()=>Response.json({html_url:releaseUrl,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:f.now(),body:'x'.repeat(100001)});
 assert.equal((await run(f)).reason,'evidence_or_history_unavailable');assert.equal(f.events.some(e=>['model_post','warpcore_verification_reserve','warpcore_verification_dispatch'].includes(e.name)),false);
 }
});
test('V5 accepts meaningful asymmetric prose within real combined post budget, unlike historical half caps',async()=>{
 const {normalizeVerificationResult}=await import('./verification-contract.mjs');
 const f=fixture(),summary='The release introduces offline execution for local inference engines, making the new capability available without relying on a hosted inference endpoint.';
 const prior=f.result.editorial.summary;f.result.editorial.summary=summary;f.result.claims.find(c=>c.claim===prior).claim=summary;
 const base=f.evidenceFetcher;f.evidenceFetcher=async(...args)=>new Response((await(await base(...args)).text())+' '+summary,{headers:{'content-type':'text/plain'}});
 assert.equal((await run(f)).status,'submitted');const wire=wireResult(f.result,f.projectedInput);const {reconstructVerificationInput}=await import('./verification-contract.mjs');const input=reconstructVerificationInput(f.projectedInput);
 assert.throws(()=>normalizeVerificationResult(wire,input,{version:'2026-11-17.verify.4'}));assert.equal(normalizeVerificationResult(wire,input).editorial.summary,'AMD reports: '+summary);assert.ok(f.material.editorial.summary.length>f.material.editorial.whyItMatters.length*2);assert.equal(f.events.filter(e=>e.name==='warpcore_agent_issue_receipt').length,1);
});
test('V5 combined overflow and oversized concise reason settle and archive before deferral, never receipt',async()=>{
 for(const kind of ['combined','reason']){const f=fixture();if(kind==='reason')f.result.scopeReason='x'.repeat(241);else for(const key of ['summary','whyItMatters']){const old=f.result.editorial[key];f.result.editorial[key]='x'.repeat(180);f.result.claims.find(c=>c.claim===old).claim=f.result.editorial[key];}
 const out=await run(f),settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(out.status,'deferred');assert.equal(out.reason,kind==='reason'?'unsupported_verification':'verification_post_unpublishable');assert.equal(settled.p_cost,.01);assert.deepEqual(settled.p_audit.result,wireResult(f.result,f.projectedInput));assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);}
});
test('V6 API metadata or date chunks cannot support substantive claims and known usage still settles',async()=>{
 for(const kind of ['metadata','date']){const f=fixture(),releaseUrl='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1',item={...evidence,url:releaseUrl,sourceLinks:[releaseUrl]},baseRpc=f.rpc,baseModel=f.modelFetcher;
 f.config.allowedSourceHosts=['github.com'];f.rpc=async(name,args)=>name==='warpcore_curator_snapshot'?{story_key:story,evidence_hash:evidenceHash,evidence:[item]}:baseRpc(name,args);
 f.evidenceFetcher=async()=>Response.json({html_url:releaseUrl,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:f.now(),body:'A new supported local inference capability was released.',assets:[{name:'Setup.exe',download_count:42}]});
 delete f.result.claims;f.modelFetcher=async(...args)=>{const source=JSON.parse(JSON.parse(args[1].body).messages[1].content).sources[0];f.result.supports=Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,source.quoteRoles[k==='publicationDate'?'publicationDate':'content'][0]]));f.result.supports.change=kind==='date'?source.quoteRoles.publicationDate[0]:source.bodyChunks.find(c=>!Object.values(source.quoteRoles).flat().includes(c.id)).id;return baseModel(...args);};
 const out=await run(f),settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(out.status,'deferred');assert.equal(out.reason,'billed_invalid_completion');assert.equal(settlement.p_status,'settled');assert.equal(settlement.p_cost,.01);assert.equal(settlement.p_audit.validationError,'invalid_verification_schema');assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_verification_finish'));
 }
});
test('verification accepts60s model calls while retaining10s source acquisition deadlines',async t=>{
 const f=fixture(),delays=[],timer=setTimeout;t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{delays.push(delay);return timer(fn,delay,...args);});f.config.timeoutMs=60000;assert.equal((await run(f)).status,'submitted');assert.ok(delays.includes(10000));assert.ok(delays.includes(60000));const bad=fixture();bad.config.timeoutMs=60001;assert.equal((await run(bad)).reason,'invalid_configuration');assert.equal(bad.events.length,0);
});


test('reviewed news report can complete verification with retained attribution',async()=>{
 const f=fixture(),base=f.rpc,source=f.evidenceFetcher,news='https://www.theverge.com/science/voyager';f.config.allowedSourceHosts=['www.theverge.com'];
 f.rpc=async(name,args)=>{const r=await base(name,args);if(name==='warpcore_curator_snapshot')r.evidence=r.evidence.map(e=>({...e,url:news,sourceLinks:[news]}));return r;};
 f.evidenceFetcher=(_url,options)=>source(url,options);for(const claim of f.result.claims)claim.url=news;
 assert.equal((await run(f)).status,'submitted');assert.match(f.material.editorial.summary,/^The Verge reports: /);
});
test('source failures retain a sanitized reason and never reserve model spend',async()=>{
 const f=fixture();f.evidenceFetcher=async()=>{throw Object.assign(Error('private-secret'),{code:'timeout'});};
 const out=await run(f);assert.equal(out.status,'deferred');const finished=f.events.find(e=>e.name==='warpcore_verification_finish');assert.equal(finished.args.p_reason,'source_transport_failure');assert.equal(f.events.some(e=>e.name==='model_post'),false);assert.equal(JSON.stringify(finished).includes('private-secret'),false);
});

test('history lock contention recovers with bounded retries before one paid submission',async()=>{
 const f=fixture(),base=f.rpc;let calls=0;f.rpc=async(name,args)=>{if(name==='warpcore_agent_history'&&++calls<3)throw Object.assign(Error('sanitized'),{code:'history_lock_contention'});return base(name,args);};
 assert.equal((await run(f)).status,'submitted');assert.equal(calls,3);for(const name of ['model_post','warpcore_verification_reserve','warpcore_agent_issue_receipt','warpcore_verification_handoff'])assert.equal(f.events.filter(e=>e.name===name).length,1);
});
test('exhausted history contention defers without source, reservation or paid work',async()=>{
 const f=fixture(),base=f.rpc;let calls=0;f.rpc=async(name,args)=>{if(name==='warpcore_agent_history'){calls++;throw Object.assign(Error('private'),{code:'history_lock_contention'});}return base(name,args);};
 const out=await run(f);assert.equal(out.reason,'history_lock_contention');assert.equal(calls,3);assert.equal(f.events.at(-1).args.p_reason,'history_lock_contention');assert.equal(f.events.some(e=>['source_get','model_post','warpcore_verification_reserve'].includes(e.name)),false);
});
test('ordinary history failures are not retried',async()=>{
 const f=fixture(),base=f.rpc;let calls=0;f.rpc=async(name,args)=>{if(name==='warpcore_agent_history'){calls++;throw Error('history_lock_contention');}return base(name,args);};assert.equal((await run(f)).reason,'evidence_or_history_unavailable');assert.equal(calls,1);
});
test('retried later history page preserves cursor and snapshot consistency',async()=>{
 for(const changed of [false,true]){const f=fixture(),base=f.rpc,cursors=[];f.rpc=async(name,args)=>{if(name!=='warpcore_agent_history')return base(name,args);cursors.push(args.p_cursor);if(cursors.length===2)throw Object.assign(Error(),{code:'history_lock_contention'});return {snapshotHash:changed&&cursors.length===3?'d'.repeat(64):historyHash,historyCoverageMode:'all-published-plus-unresolved-v1',items:cursors.length===1?[{kind:'publication',storyKey:'e'.repeat(64),record:{text:'Old public event.'},candidateContext:[]}]:[],cursor:'p:first',complete:cursors.length===3};};assert.equal((await run(f)).status,changed?'deferred':'submitted');assert.deepEqual(cursors,[null,'p:first','p:first']);if(changed)assert.equal(f.events.some(e=>e.name==='model_post'),false);}
});
test('history retry backoff retains the original acquisition deadline',async t=>{
 const f=fixture(),base=f.rpc,delays=[];let clock=0,calls=0;t.mock.method(Date,'now',()=>clock);t.mock.method(globalThis,'setTimeout',(fn,delay)=>{delays.push(delay);clock+=31000;queueMicrotask(fn);return 1;});f.rpc=async(name,args)=>{if(name==='warpcore_agent_history'){calls++;throw Object.assign(Error(),{code:'history_lock_contention'});}return base(name,args);};assert.equal((await run(f)).reason,'evidence_or_history_unavailable');assert.equal(calls,1);assert.deepEqual(delays,[100]);assert.equal(f.events.some(e=>e.name==='model_post'),false);
});
test('malformed history after recovered contention still fails closed',async()=>{
 const f=fixture(),base=f.rpc;let calls=0;f.rpc=async(name,args)=>{if(name!=='warpcore_agent_history')return base(name,args);if(++calls===1)throw Object.assign(Error(),{code:'history_lock_contention'});return {snapshotHash:historyHash,items:[],complete:false,cursor:null};};assert.equal((await run(f)).reason,'evidence_or_history_unavailable');assert.equal(calls,2);assert.equal(f.events.some(e=>['model_post','warpcore_verification_reserve','warpcore_verification_handoff'].includes(e.name)),false);
});
