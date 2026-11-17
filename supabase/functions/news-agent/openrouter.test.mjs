import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewWithOpenRouter,serializeReviewBody,validateReviewProvider} from './openrouter.mjs';
import {DISCOVERY_RESPONSE_FORMAT} from './evaluation.mjs';
const request=()=>({model:'test/model',max_tokens:100,messages:[{role:'system',content:'Review only'},{role:'user',content:JSON.stringify({candidates:[{id:'a'}]})}],response_format:structuredClone(DISCOVERY_RESPONSE_FORMAT)});
const config=()=>({enabled:true,apiKey:'test-only-key',allowedModels:['test/model'],reservation:{id:'attempt-1',maxCostCredits:0.01},timeoutMs:50,maxResponseBytes:20000});
const payload=()=>({id:'gen-test',model:'test/model',choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:[{id:'a',action:'verify',reason:'Material feature'}]})}}],usage:{prompt_tokens:20,completion_tokens:15,total_tokens:35,cost:0.001}});
const response=()=>Response.json(payload());
test('disabled by default and missing reservation never invoke transport',async()=>{
 for(const c of [{}, {...config(),enabled:false},{...config(),reservation:null},{...config(),allowedModels:[]}]){
  await assert.rejects(reviewWithOpenRouter(request(),c,()=>{throw Error('must not run');}),e=>e.outcome==='not_started');
 }
});
test('fixed OpenRouter endpoint, no redirects/fallbacks, bounded request and parsed response',async()=>{
 let calls=0;
 const result=await reviewWithOpenRouter(request(),config(),async(url,options)=>{
  calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.equal(body.stream,false);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.provider.require_parameters,true);
  assert.equal(options.headers.Authorization,'Bearer test-only-key');assert.ok(options.signal instanceof AbortSignal);return response();
 });
 assert.equal(calls,1);assert.equal(result.decisions[0].action,'verify');assert.equal(result.usage.costCredits,0.001);assert.equal(result.generationId,'gen-test');
});
test('rejects alternate routing and unbounded output before transmission',async()=>{
 for(const r of [{...request(),models:['other']},{...request(),tools:[]},{...request(),max_tokens:0},{...request(),max_tokens:16385},{...request(),provider:{order:['other']}},{...request(),model:'unapproved'}])await assert.rejects(reviewWithOpenRouter(r,config(),()=>{throw Error('must not run');}),e=>e.outcome==='not_started');
});
test('cost-bearing transport and HTTP errors are uncertain, sanitized and never retried',async()=>{
 for(const transport of [async()=>{throw Error('secret raw error')},async()=>new Response('secret provider error',{status:429})]){
  let calls=0;await assert.rejects(reviewWithOpenRouter(request(),config(),async(...args)=>{calls++;return transport(...args)}),e=>e.outcome==='uncertain'&&!e.message.includes('secret'));
  assert.equal(calls,1);
 }
});
test('timeout bounds even a transport that ignores abort and never retries',async()=>{
 let signal;const start=Date.now();
 await assert.rejects(reviewWithOpenRouter(request(),{...config(),timeoutMs:10},async(_u,o)=>{signal=o.signal;return new Promise(()=>{});}),e=>e.code==='timeout'&&e.outcome==='uncertain');
 assert.equal(signal.aborted,true);assert.ok(Date.now()-start<1000);
});
test('streamed body is bounded without trusting content-length',async()=>{
 const huge=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(20001)));c.close();}});
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>new Response(huge)),e=>e.code==='response_too_large'&&e.outcome==='uncertain');
});
test('missing usage, truncated output, changed model, invalid decisions fail closed',async()=>{
 const missing=payload();delete missing.usage;
 const noCost=payload();delete noCost.usage.cost;
 const truncated=payload();truncated.choices[0].finish_reason='length';
 const changed=payload();changed.model='other';
 const malformed=payload();malformed.choices[0].message.content='not json';
 const unknown=payload();unknown.choices[0].message.content=JSON.stringify({decisions:[{id:'b',action:'verify',reason:'x'}]});
 const empty=payload();empty.choices[0].message.content=JSON.stringify({decisions:[]});
 const duplicate=payload();duplicate.choices[0].message.content=JSON.stringify({decisions:[{id:'a',action:'skip',reason:'x'},{id:'a',action:'verify',reason:'y'}]});
 for(const p of [missing,noCost,truncated,changed,malformed,unknown,empty,duplicate])await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>e.outcome==='uncertain');
});
test('reported overspend retains usage for reconciliation',async()=>{
 const p=payload();p.usage.cost=0.02;
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>e.code==='reservation_exceeded'&&e.usage.costCredits===0.02&&e.outcome==='uncertain');
});
test('caller mutation during fetch cannot change model or cost acceptance',async()=>{
 const r=request(),c=config();
 await assert.rejects(reviewWithOpenRouter(r,c,async()=>{
  r.model='other';c.reservation.maxCostCredits=100;
  const p=payload();p.model='other';p.usage.cost=0.02;return Response.json(p);
 }),e=>e.code==='reservation_exceeded');
});
test('HTTP failure cancels stalled diagnostic body and aborts transport',async()=>{
 let cancelled=false,signal;
 const request={model:'test/model',max_tokens:100,messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify({candidates:[{id:'one'}]})}],response_format:structuredClone(DISCOVERY_RESPONSE_FORMAT)};
 await assert.rejects(reviewWithOpenRouter(request,{enabled:true,apiKey:'offline',allowedModels:['test/model'],reservation:{id:'r',maxCostCredits:1},timeoutMs:10},async(_url,options)=>{
  signal=options.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429});
 }));
 assert.equal(cancelled,true);assert.equal(signal.aborted,true);
});
test('declared oversized body is cancelled before reading',async()=>{
 let cancelled=false;
 const request={model:'test/model',max_tokens:100,messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify({candidates:[{id:'one'}]})}],response_format:structuredClone(DISCOVERY_RESPONSE_FORMAT)};
 await assert.rejects(reviewWithOpenRouter(request,{enabled:true,apiKey:'offline',allowedModels:['test/model'],reservation:{id:'r',maxCostCredits:1},maxResponseBytes:10},async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'999'}})));
 assert.equal(cancelled,true);
});
const pinnedProvider=()=>({only:['test-provider'],order:['test-provider'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.2,completion:1.2,request:0}});
test('omitted temperature and strict discovery schema are accepted without optional model parameters',async()=>{
 const r=request();delete r.temperature;
 const result=await reviewWithOpenRouter(r,config(),async(_url,options)=>{assert.equal(Object.hasOwn(JSON.parse(options.body),'temperature'),false);return response();});
 assert.equal(result.decisions.length,1);
});
test('rejects temperature and any nontrusted output schema before transmission',async()=>{
 const altered=[r=>r.temperature=0,r=>r.temperature=1,r=>r.response_format={type:'json_object'},r=>r.response_format.json_schema.strict=false,r=>r.response_format.json_schema.schema.additionalProperties=true,r=>r.response_format.json_schema.schema.properties.decisions.items.properties.action.enum.push('publish'),r=>r.response_format.json_schema.schema.properties.decisions.items.required.pop(),r=>r.response_format.json_schema.other='instruction'];
 for(const change of altered){const r=request();change(r);let calls=0;await assert.rejects(reviewWithOpenRouter(r,config(),async()=>{calls++;return response();}),e=>e.outcome==='not_started');assert.equal(calls,0);}
});
test('preserves exact validated pinned provider and price ceilings in transmitted request',async()=>{
 const r={...request(),provider:pinnedProvider()};
 await reviewWithOpenRouter(r,config(),async(_url,options)=>{assert.deepEqual(JSON.parse(options.body).provider,r.provider);return response();});
});
test('rejects alternate provider shapes and invalid price dimensions before transmission',async()=>{
 const changes=[p=>p.only.push('other'),p=>p.order=['other'],p=>p.only=['https://evil.test'],p=>p.allow_fallbacks=true,p=>p.require_parameters=false,p=>p.max_price.request=1,p=>p.max_price.prompt=0,p=>p.max_price.completion=Infinity,p=>p.max_price.prompt=NaN,p=>p.max_price.image=0,p=>delete p.order,p=>p.data_collection='allow'];
 for(const change of changes){const provider=pinnedProvider();change(provider);let calls=0;await assert.rejects(reviewWithOpenRouter({...request(),provider},config(),async()=>{calls++;return response();}),e=>e.outcome==='not_started');assert.equal(calls,0);}
});
test('serializer validates explicit provider before hashing and returns a detached exact policy',()=>{
 const provider=pinnedProvider();const validated=validateReviewProvider(provider);validated.only[0]='changed';assert.equal(provider.only[0],'test-provider');
 const r={...request(),provider};assert.deepEqual(JSON.parse(serializeReviewBody(r)).provider,provider);
 for(const bad of [null,undefined,{...provider,only:['a','b']},{...provider,max_price:{...provider.max_price,request:0.01}}])assert.throws(()=>serializeReviewBody({...request(),provider:bad}),e=>e.code==='unsupported_request');
});
test('caller mutation after dispatch cannot alter transmitted schema, provider, or expected candidate IDs',async()=>{
 const r={...request(),provider:pinnedProvider()};let transmitted;
 const result=await reviewWithOpenRouter(r,config(),async(_url,options)=>{
  transmitted=JSON.parse(options.body);
  r.provider.only[0]='other';r.provider.max_price.request=100;r.response_format.json_schema.schema.properties.decisions.items.properties.action.enum.push('publish');
  r.messages[1].content=JSON.stringify({candidates:[{id:'b'}]});
  return response();
 });
 assert.equal(result.decisions[0].id,'a');assert.equal(transmitted.provider.only[0],'test-provider');assert.equal(transmitted.provider.max_price.request,0);
 assert.deepEqual(transmitted.response_format.json_schema.schema.properties.decisions.items.properties.action.enum,['skip','verify']);
});
test('exact none reasoning is serialized while unknown reasoning controls fail before HTTP',async()=>{
 const r={...request(),reasoning:{effort:'none'}};
 await reviewWithOpenRouter(r,config(),async(_url,options)=>{assert.deepEqual(JSON.parse(options.body).reasoning,{effort:'none'});r.reasoning.effort='high';return response();});
 for(const reasoning of [null,undefined,{effort:'high'},{effort:'none',exclude:true},{max_tokens:0},{effort:'none',max_tokens:0}]){
  let calls=0;await assert.rejects(reviewWithOpenRouter({...request(),reasoning},config(),async()=>{calls++;return response();}),e=>e.outcome==='not_started');assert.equal(calls,0);
  assert.throws(()=>serializeReviewBody({...request(),reasoning}),e=>e.outcome==='not_started');
 }
});
test('valid upstream provider is retained while absent unconfigured provider preserves result shape',async()=>{
 const p=payload();p.provider='Test Provider';
 const result=await reviewWithOpenRouter(request(),config(),async()=>Response.json(p));assert.equal(result.provider,'Test Provider');
 const unconfigured=await reviewWithOpenRouter(request(),config(),async()=>response());assert.equal(Object.hasOwn(unconfigured,'provider'),false);
});
test('expected provider must match upstream exactly and mismatches preserve known usage',async()=>{
 for(const provider of [undefined,'Other Provider']){
  const p=payload();if(provider!==undefined)p.provider=provider;
  await assert.rejects(reviewWithOpenRouter(request(),{...config(),expectedProvider:'Test Provider'},async()=>Response.json(p)),e=>e.code==='invalid_completion'&&e.usage.costCredits===0.001&&e.outcome==='uncertain');
 }
 const p=payload();p.provider='Test Provider';
 assert.equal((await reviewWithOpenRouter(request(),{...config(),expectedProvider:'Test Provider'},async()=>Response.json(p))).provider,'Test Provider');
});
test('malformed upstream provider fails completion with known cost',async()=>{
 for(const provider of [null,1,{},[],true,'','  ',' Leading','Trailing ','x'.repeat(129),'New\nLine','Tab\tName','Nul\u0000Name','Control\u0085Name']){
  const p=payload();p.provider=provider;
  await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>e.code==='invalid_completion'&&e.usage.costCredits===0.001&&e.outcome==='uncertain');
 }
});
test('invalid expected provider fails before transport and mutation cannot weaken the pinned expectation',async()=>{
 for(const expectedProvider of [undefined,null,1,'','  ',' Leading','Trailing ','x'.repeat(129),'New\nLine']){
  let calls=0;await assert.rejects(reviewWithOpenRouter(request(),{...config(),expectedProvider},async()=>{calls++;return response();}),e=>e.outcome==='not_started');assert.equal(calls,0);
 }
 const c={...config(),expectedProvider:'Test Provider'};
 await assert.rejects(reviewWithOpenRouter(request(),c,async()=>{c.expectedProvider='Other Provider';const p=payload();p.provider='Other Provider';return Response.json(p);}),e=>e.code==='invalid_completion'&&e.usage.costCredits===0.001);
});
test('HTTP error diagnostics expose only status and fixed code/type classifications without raw content',async()=>{
 const privateText='synthetic-secret-key-and-private-prompt';let calls=0;
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>{
  calls++;return Response.json({error:{code:400,message:privateText,metadata:{provider_name:privateText,raw:JSON.stringify({error:{type:'invalid_request_error',code:'unsupported_parameter',message:privateText}})}}},{status:400});
 }),e=>{
  assert.equal(e.code,'http_failure');assert.equal(e.outcome,'uncertain');assert.equal(e.httpStatus,400);assert.equal(e.providerErrorCode,'unsupported_parameter');assert.equal(e.providerErrorType,'invalid_request_error');
  assert.equal(JSON.stringify(e).includes(privateText),false);assert.equal(e.message.includes(privateText),false);assert.equal(Object.hasOwn(e,'usage'),false);return true;
 });assert.equal(calls,1);
});
test('unknown HTTP error codes/types, malformed bodies and headers never enter diagnostics',async()=>{
 for(const body of [JSON.stringify({error:{code:'secret-arbitrary-code',type:'secret-type',message:'secret',metadata:{raw:'secret'}}}),'secret plain body','not json',JSON.stringify({error:{code:123456,type:123}})]){
  await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>new Response(body,{status:502,headers:{'x-private-error':'secret'}})),e=>{assert.equal(e.code,'http_failure');assert.equal(e.httpStatus,502);assert.equal(Object.hasOwn(e,'providerErrorCode'),false);assert.equal(Object.hasOwn(e,'providerErrorType'),false);assert.equal(JSON.stringify(e).includes('secret'),false);return true;});
 }
});
test('recognized string error classification is retained without diagnostic free text',async()=>{
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:'rate_limit_exceeded',type:'rate_limit_error',message:'secret'}},{status:429})),e=>e.code==='http_failure'&&e.httpStatus===429&&e.providerErrorCode==='rate_limit_exceeded'&&e.providerErrorType==='rate_limit_error');
});
test('oversized error diagnostics cancel their body and retain HTTP status',async()=>{
 let cancelled=false;
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(8193)));},cancel(){cancelled=true;}}),{status:413})),e=>e.code==='http_failure'&&e.httpStatus===413);
 assert.equal(cancelled,true);
});
test('slow error body stays within original timeout, is cancelled and retains observed HTTP status',async()=>{
 let cancelled=false,signal;const start=Date.now();
 await assert.rejects(reviewWithOpenRouter(request(),{...config(),timeoutMs:10},async(_url,options)=>{signal=options.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:503});}),e=>e.code==='timeout'&&e.outcome==='uncertain'&&e.httpStatus===503);
 assert.equal(cancelled,true);assert.equal(signal.aborted,true);assert.ok(Date.now()-start<1000);
});
test('invalid decision diagnostics identify only fixed issue and index while retaining known cost and completion identity',async()=>{
 const secret='synthetic-private-decision-text';
 for(const [decision,validationIssue] of [[null,'invalid_shape'],[{id:'a',action:'verify',reason:'x',private:secret},'unexpected_fields'],[{id:'unknown-secret-id',action:'verify',reason:secret},'unknown_id'],[{id:'a',action:'publish-secret',reason:secret},'invalid_action'],[{id:'a',action:'verify',reason:''},'invalid_reason'],[{id:'a',action:'verify',reason:secret.repeat(100)},'invalid_reason']]){
  const p=payload();p.provider='Test Provider';p.choices[0].message.content=JSON.stringify({decisions:[decision]});
  await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>{
   assert.equal(e.code,'invalid_decisions');assert.equal(e.validationIssue,validationIssue);assert.equal(e.decisionIndex,0);assert.equal(e.outcome,'uncertain');assert.equal(e.usage.costCredits,0.001);
   assert.deepEqual(e.completionAudit,{model:'test/model',generationId:'gen-test',provider:'Test Provider'});assert.equal(JSON.stringify(e).includes(secret),false);assert.equal(JSON.stringify(e).includes('unknown-secret-id'),false);return true;
  });
 }
});
test('duplicate decision diagnostic identifies offending index without retaining model decisions',async()=>{
 const r=request();r.messages[1].content=JSON.stringify({candidates:[{id:'a'},{id:'b'}]});
 const p=payload();p.choices[0].message.content=JSON.stringify({decisions:[{id:'a',action:'verify',reason:'private reason one'},{id:'a',action:'skip',reason:'private reason two'}]});
 await assert.rejects(reviewWithOpenRouter(r,config(),async()=>Response.json(p)),e=>e.code==='invalid_decisions'&&e.validationIssue==='duplicate_id'&&e.decisionIndex===1&&!JSON.stringify(e).includes('private reason'));
});
test('completion audit accompanies malformed or incomplete decisions only after completion identity is validated',async()=>{
 for(const content of ['secret invalid JSON',JSON.stringify({decisions:[]})]){
  const p=payload();p.choices[0].message.content=content;
  await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>{assert.deepEqual(e.completionAudit,{model:'test/model',generationId:'gen-test'});assert.equal(Object.hasOwn(e,'decisionIndex'),false);assert.equal(JSON.stringify(e).includes('secret invalid JSON'),false);return true;});
 }
 for(const change of [p=>p.model='other',p=>p.provider=' Invalid',p=>p.id='bad\nidentity',p=>p.choices[0].finish_reason='length']){
  const p=payload();change(p);
  await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json(p)),e=>e.code==='invalid_completion'&&!Object.hasOwn(e,'completionAudit'));
 }
});
test('ranked decisions retain scores and reject bad scores with billed usage',async()=>{
 const {DISCOVERY_RANKED_RESPONSE_FORMAT}=await import('./review-contract.mjs');
 assert.ok(DISCOVERY_RANKED_RESPONSE_FORMAT);
 const r={...request(),response_format:structuredClone(DISCOVERY_RANKED_RESPONSE_FORMAT)};
 const decision={id:'a',action:'verify',reason:'Material feature',importance:4,relevance:3};
 const answer=d=>{const p=payload();p.choices[0].message.content=JSON.stringify({decisions:d});return Response.json(p);};
 assert.deepEqual((await reviewWithOpenRouter(r,config(),async()=>answer([decision]))).decisions,[decision]);
 for(const d of [{...decision,importance:5},{...decision,relevance:1.5},{...decision,importance:-1},{...decision,importance:0},{...decision,action:'skip'},{id:'a',action:'verify',reason:'Missing scores'},{...decision,relevance:'3'}]){
  await assert.rejects(reviewWithOpenRouter(r,config(),async()=>answer([d])),e=>e.code==='invalid_decisions'&&e.usage.costCredits===0.001&&e.completionAudit.generationId==='gen-test');
 }
 await assert.rejects(reviewWithOpenRouter(r,config(),async()=>answer([])),e=>e.code==='incomplete_decisions'&&e.usage.costCredits===0.001);
 assert.equal((await reviewWithOpenRouter(r,config(),async()=>answer([{...decision,action:'skip',importance:0,relevance:0}]))).decisions[0].importance,0);
});
test('keyed ranked completion normalizes candidate order and rejects missing, extra, inner IDs or scores with usage',async()=>{
 const {buildKeyedRankedDiscoveryFormat}=await import('./review-contract.mjs');assert.equal(typeof buildKeyedRankedDiscoveryFormat,'function');
 const r={...request(),messages:[request().messages[0],{role:'user',content:JSON.stringify({candidates:[{id:'a'},{id:'b'}]})}],response_format:buildKeyedRankedDiscoveryFormat(['a','b'])};
 const a={action:'verify',reason:'Material capability.',importance:4,relevance:3},b={action:'skip',reason:'Routine.',importance:0,relevance:0};
 const response=decisions=>{const p=payload();p.choices[0].message.content=JSON.stringify({decisions});return Response.json(p);};
 const out=await reviewWithOpenRouter(r,config(),async()=>response({b,a}));assert.deepEqual(out.decisions,[{id:'a',...a},{id:'b',...b}]);
 for(const d of [{a},{a,b,c:a},{a:{...a,id:'other'},b},{a:{...a,importance:5},b},{a:{...a,relevance:1.5},b},{a,b:{...b,importance:1}},{a:{action:'verify',reason:'Missing scores'},b}])await assert.rejects(reviewWithOpenRouter(r,config(),async()=>response(d)),e=>e.outcome==='uncertain'&&e.usage.costCredits===.001&&e.completionAudit.generationId==='gen-test');
 for(const mutate of [x=>x.response_format.json_schema.schema.properties.decisions.required.pop(),x=>x.response_format.json_schema.schema.properties.decisions.properties.a.additionalProperties=true,x=>x.messages[1].content=JSON.stringify({candidates:[{id:'x'},{id:'b'}]})]){const bad=structuredClone(r);mutate(bad);let calls=0;await assert.rejects(reviewWithOpenRouter(bad,config(),async()=>{calls++;return response({a,b});}),e=>e.outcome==='not_started');assert.equal(calls,0);}
});
test('sixteen-candidate keyed schema requires the candidate omitted by the historical array completion',async()=>{
 const {buildReviewRequest}=await import('./evaluation.mjs'),{requestProfileForModel}=await import('./model-profiles.mjs');
 const model='openai/gpt-oss-120b',inputs=Array.from({length:16},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),sourceUrl:'https://example.com/release',discoveryText:'Synthetic capability.'}));
 const r=buildReviewRequest(inputs,{model,allowedModels:[model],maxOutputTokens:4096,requestProfile:requestProfileForModel(model,'2026-11-16.4')});
 assert.deepEqual(r.response_format.json_schema.schema.properties.decisions.required,inputs.map(c=>c.id));
 const reply=n=>{const p=payload();p.model=model;p.provider='Groq';p.usage={prompt_tokens:1000,completion_tokens:2021,total_tokens:3021,cost:.0019665};p.choices[0].message.content=JSON.stringify({decisions:Object.fromEntries(inputs.slice(0,n).map(c=>[c.id,{action:'skip',reason:'Routine fixture.',importance:0,relevance:0}]))});return Response.json(p);};
 const cfg={...config(),allowedModels:[model],expectedProvider:'Groq'};
 await assert.rejects(reviewWithOpenRouter(r,cfg,async()=>reply(15)),e=>e.code==='incomplete_decisions'&&e.usage.costCredits===.0019665&&e.completionAudit.provider==='Groq');
 assert.equal((await reviewWithOpenRouter(r,cfg,async()=>reply(16))).decisions.length,16);
});
test('coded ranking has exactly seventeen valid states and normalizes all in candidate order',async()=>{
 const {buildKeyedCodedRankingFormat,DISCOVERY_RATING_CODES}=await import('./review-contract.mjs');assert.equal(typeof buildKeyedCodedRankingFormat,'function');
 const codes=['skip',...Array.from({length:4},(_,i)=>Array.from({length:4},(_,r)=>`verify_i${i+1}_r${r+1}`)).flat()];assert.deepEqual(DISCOVERY_RATING_CODES,codes);
 const ids=codes.map((_,i)=>'coded-'+i),r={...request(),messages:[request().messages[0],{role:'user',content:JSON.stringify({candidates:ids.map(id=>({id}))})}],response_format:buildKeyedCodedRankingFormat(ids)};
 const reply=decisions=>{const p=payload();p.choices[0].message.content=JSON.stringify({decisions});return Response.json(p);};
 const decisions=Object.fromEntries(ids.map((id,i)=>[id,{rating:codes[i],reason:'Fixture.'}]).reverse());
 const out=await reviewWithOpenRouter(r,config(),async()=>reply(decisions));
 assert.deepEqual(out.decisions,ids.map((id,i)=>({id,action:i?'verify':'skip',reason:'Fixture.',importance:i?Math.floor((i-1)/4)+1:0,relevance:i?(i-1)%4+1:0})));
 for(const patch of [{rating:'verify_i0_r1',reason:'Fixture.'},{rating:'verify_i1_r5',reason:'Fixture.'},{rating:'skip',reason:'Fixture.',action:'verify'},{rating:'skip',reason:'Fixture.',importance:1}])await assert.rejects(reviewWithOpenRouter(r,config(),async()=>reply({...decisions,[ids[0]]:patch})),e=>e.usage.costCredits===.001&&e.completionAudit.generationId==='gen-test');
 const missing={...decisions};delete missing[ids[0]];await assert.rejects(reviewWithOpenRouter(r,config(),async()=>reply(missing)),e=>e.code==='incomplete_decisions'&&e.usage.costCredits===.001);
 const bad=structuredClone(r);bad.response_format.json_schema.schema.properties.decisions.properties[ids[0]].properties.rating.enum.push('verify_i0_r1');let calls=0;await assert.rejects(reviewWithOpenRouter(bad,config(),async()=>{calls++;return reply(decisions);}),e=>e.outcome==='not_started');assert.equal(calls,0);
});
test('upstream 429 metadata and retry correlation survive without raw provider text',async()=>{
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:429,message:'private text',metadata:{error_type:'rate_limit_exceeded',provider_code:'rate_limited',provider_name:'DeepInfra',limit_source:'upstream_provider_shared_pool',raw:'private text'}}},{status:429,headers:{'retry-after':'60','x-request-id':'req-safe_123','cf-ray':'0123456789abcdef-IAD'}})),e=>{
 assert.equal(e.providerErrorCode,'rate_limited');assert.equal(e.providerErrorType,'rate_limit_exceeded');assert.equal(e.errorProvider,'DeepInfra');assert.equal(e.limitSource,'upstream_provider_shared_pool');assert.equal(e.retryAfterSeconds,60);assert.equal(e.requestId,'req-safe_123');assert.equal(e.cloudflareRay,'0123456789abcdef-IAD');assert.equal(JSON.stringify(e).includes('private text'),false);return true;
 });
});
test('HTTP diagnostics reject unknown enums, oversized waits, unsafe IDs and credential-shaped correlations',async()=>{
 const {sanitizedHttpDiagnostics}=await import('./openrouter.mjs');
 assert.deepEqual(sanitizedHttpDiagnostics({providerErrorCode:'private-code',providerErrorType:'private-type',errorProvider:'unreviewed-provider',limitSource:'private-limit',retryAfterSeconds:86401,requestId:'req-secret_123',cloudflareRay:'0123456789abcdef-IAD',raw:'secret'},'secret'),{cloudflareRay:'0123456789abcdef-IAD'});
 for(const requestId of ['req-','req-space value','req-'+'x'.repeat(125),'gen-bad\nvalue','sk-secret'])assert.deepEqual(sanitizedHttpDiagnostics({requestId}),{});
 for(const value of [-1,.5,Infinity,NaN,'60'])assert.deepEqual(sanitizedHttpDiagnostics({retryAfterSeconds:value}),{});
 for(const retry of ['-1','1.5','999999','private-date'])await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>new Response('private body',{status:429,headers:{'retry-after':retry,'x-request-id':'private-text'}})),e=>e.httpStatus===429&&!Object.hasOwn(e,'retryAfterSeconds')&&!Object.hasOwn(e,'requestId')&&!JSON.stringify(e).includes('private'));
 const future=new Date(Date.now()+60000).toUTCString();await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>new Response('{}',{status:429,headers:{'retry-after':future}})),e=>Number.isInteger(e.retryAfterSeconds)&&e.retryAfterSeconds>=58&&e.retryAfterSeconds<=60);
});
test('correlation IDs reject terminal control characters despite regex end anchors',async()=>{
 const {sanitizedHttpDiagnostics}=await import('./openrouter.mjs');for(const suffix of ['\n','\r','\u0085'])assert.deepEqual(sanitizedHttpDiagnostics({requestId:'req-safe_123'+suffix,cloudflareRay:'0123456789abcdef-IAD'+suffix}),{});
});
test('actual DeepInfra engine overload code takes precedence over wrapper and alternate metadata fields',async()=>{
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:429,message:'private upstream message',metadata:{provider_name:'DeepInfra',provider_error_code:'engine_overloaded',provider_code:'rate_limited',limit_source:'upstream_provider_shared_pool',raw:'private temporary rate limit text'}}},{status:429})),e=>e.httpStatus===429&&e.providerErrorCode==='engine_overloaded'&&e.errorProvider==='DeepInfra'&&e.limitSource==='upstream_provider_shared_pool'&&!JSON.stringify(e).includes('private'));
});
test('Together diagnostic identity is retained only as reviewed provider enum',async()=>{
 const {sanitizedHttpDiagnostics}=await import('./openrouter.mjs');assert.deepEqual(sanitizedHttpDiagnostics({errorProvider:'Together',providerErrorCode:'engine_overloaded'}),{errorProvider:'Together',providerErrorCode:'engine_overloaded'});assert.deepEqual(sanitizedHttpDiagnostics({errorProvider:'Together private text'}),{});
});
test('explicit provider context/schema wording maps only to fixed diagnostics and specific upstream codes win',async()=>{
 for(const [message,expected] of [['Maximum context length of 65536 tokens was exceeded','context_length_exceeded'],['Prompt contains 90000 tokens and exceeds the model limit','context_length_exceeded'],['JSON schema uses an unsupported keyword','unsupported_parameter'],['response_format is not supported','unsupported_parameter']])await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:400,type:'invalid_request_error',message:'private-key '+message}},{status:400})),e=>e.providerErrorCode===expected&&e.providerErrorType==='invalid_request_error'&&!JSON.stringify(e).includes('private-key'));
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:400,metadata:{provider_error_code:'engine_overloaded',raw:JSON.stringify({error:{message:'Maximum context length is exceeded'}})}}},{status:400})),e=>e.providerErrorCode==='engine_overloaded');
 await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:400,message:'private arbitrary failure'}},{status:400})),e=>e.providerErrorCode===400&&!JSON.stringify(e).includes('private arbitrary'));
});

test('context diagnostics do not infer overflow from a supported token limit alone',async()=>{for(const message of ['Invalid request: input tokens are 10, within the supported limit','Maximum context length is 131072; input remains within budget'])await assert.rejects(reviewWithOpenRouter(request(),config(),async()=>Response.json({error:{code:400,message}},{status:400})),e=>e.providerErrorCode===400&&!JSON.stringify(e).includes(message));});
