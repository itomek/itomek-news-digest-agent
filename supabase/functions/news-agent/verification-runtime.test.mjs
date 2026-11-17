import {approvedRuntimeModel} from './approved-runtime-models.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runVerificationInvocation,VERIFICATION_RESERVATION_CREDITS} from './verification-runtime.mjs';
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,story='a'.repeat(64),evidenceHash='b'.repeat(64),historyHash='c'.repeat(64),url='https://example.com/release';
const cfg={enabled:true,apiKey:'synthetic-not-a-credential',model:'openai/gpt-oss-120b',allowedModels:['openai/gpt-oss-120b'],expectedProvider:'Groq',maxOutputTokens:4096,maxCostCredits:VERIFICATION_RESERVATION_CREDITS,allowedSourceHosts:['example.com']};
const evidence={id:'rss:release',url,text:'Discovery excerpt.',sourceType:'rss',visibility:'public',sourceLinks:[url],nativeUri:null,nativeUrl:null};
const hash=s=>createHash('sha256').update(s).digest('hex');
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
  assert.equal(hash(options.body),reservedHash);const parsed=JSON.parse(options.body),input=JSON.parse(parsed.messages[1].content);assert.equal(input.evidence[0].privateIgnored,undefined);assert.equal(JSON.stringify(input.history).includes('never-in-prompt'),false);assert.equal(parsed.stream,false);
  return Response.json({id:'fixture-generation',model:state.config.model,provider:state.config.expectedProvider,usage:{prompt_tokens:100,completion_tokens:200,total_tokens:300,cost:.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify({result:state.result})}}]});
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
 const f=fixture();f.result.claims[0].quote='invented';assert.equal((await run(f)).reason,'verification_quote_missing');assert.equal(f.events.find(e=>e.name==='warpcore_verification_settle').args.p_cost,.01);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
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
 const f=fixture(),base=f.modelFetcher;f.modelFetcher=async(...args)=>{const p=await(await base(...args)).json();p.provider='Groq\nprivate-provider';return Response.json(p);};assert.equal((await run(f)).status,'deferred');const settled=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settled.p_cost,.01);assert.equal(settled.p_status,'settled');assert.equal(settled.p_audit.errorCode,'invalid_completion');assert.deepEqual(settled.p_audit.diagnostic,{generationId:'fixture-generation',model:cfg.model});assert.equal(JSON.stringify(settled).includes('private-provider'),false);
});
test('credentials echoed into otherwise bounded identity fields cannot enter known-error audit',async()=>{
 for(const field of ['id','provider']){const f=fixture(),base=f.modelFetcher;f.modelFetcher=async(...args)=>{const p=await(await base(...args)).json();p[field]=cfg.apiKey;p.choices[0].message.content='{';return Response.json(p);};assert.equal((await run(f)).status,'deferred');const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(audit.p_cost,.01);assert.equal(JSON.stringify(audit).includes(cfg.apiKey),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);}
});

test('reviewed NVIDIA runtime reserves only its code-owned cap and records the selected actual model',async()=>{for(const model of ['nvidia/nemotron-3.5-super-vl','nvidia/nemotron-3-super-120b-a12b']){const approved=approvedRuntimeModel(model),f=fixture();Object.assign(f.config,{model,allowedModels:[model],expectedProvider:approved.provider,maxCostCredits:approved.maxCostCredits});assert.equal((await run(f)).status,'submitted');const reserve=f.events.find(x=>x.name==='warpcore_verification_reserve').args;assert.equal(reserve.p_max,approved.maxCostCredits);assert.equal(reserve.p_metadata.model,model);assert.equal(reserve.p_metadata.expectedProvider,model==='nvidia/nemotron-3.5-super-vl'?'Together':'DeepInfra');assert.equal(f.material.model,model);const bad=fixture();Object.assign(bad.config,{model,allowedModels:[model],expectedProvider:'Groq',maxCostCredits:approved.maxCostCredits});assert.equal((await run(bad)).reason,'invalid_configuration');assert.equal(bad.events.length,0);}});
test('verification429 diagnostics survive durable uncertain settlement without paid replay',async()=>{
 const f=fixture();let calls=0;f.modelFetcher=async()=>{calls++;return Response.json({error:{code:429,message:'private text',metadata:{provider_code:'rate_limited',error_type:'rate_limit_exceeded',provider_name:'DeepInfra',limit_source:'upstream_provider_shared_pool'}}},{status:429,headers:{'retry-after':'30','x-request-id':'req-verify_123'}});};
 assert.equal((await run(f)).status,'uncertain');const settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settlement.p_cost,null);assert.equal(settlement.p_status,'uncertain');assert.deepEqual(settlement.p_audit,{errorCode:'http_failure',diagnostic:{httpStatus:429,providerErrorCode:'rate_limited',providerErrorType:'rate_limit_exceeded',errorProvider:'DeepInfra',limitSource:'upstream_provider_shared_pool',retryAfterSeconds:30,requestId:'req-verify_123'}});assert.equal(JSON.stringify(settlement).includes('private text'),false);assert.equal((await run(f)).status,'idle');assert.equal(calls,1);
});
test('parsed verifier result is privately retained before semantic validation and cannot authorize a receipt',async()=>{
 const f=fixture();f.result.claims[0].quote='unsupported quoted statement';const out=await run(f);const audit=f.events.find(e=>e.name==='warpcore_verification_settle').args;
 assert.equal(audit.p_cost,.01);assert.deepEqual(audit.p_audit.result,f.result);assert.equal(out.reason,'verification_quote_missing');assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);assert.ok(f.events.findIndex(e=>e.name==='warpcore_verification_settle')<f.events.findIndex(e=>e.name==='warpcore_verification_finish'));
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
 const out=await run(f);assert.equal(out.status,'deferred');assert.equal(out.reason,'model_deferred');const settlement=f.events.find(e=>e.name==='warpcore_verification_settle').args;assert.equal(settlement.p_status,'settled');assert.equal(settlement.p_cost,.01);assert.equal(Object.hasOwn(settlement.p_audit,'result'),false);assert.equal(f.events.some(e=>e.name==='warpcore_agent_issue_receipt'),false);
 }
});
