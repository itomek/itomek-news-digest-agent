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
test('HTTP failure cancels unread body and aborts transport',async()=>{
 let cancelled=false,signal;
 const request={model:'test/model',max_tokens:100,messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify({candidates:[{id:'one'}]})}],response_format:structuredClone(DISCOVERY_RESPONSE_FORMAT)};
 await assert.rejects(reviewWithOpenRouter(request,{enabled:true,apiKey:'offline',allowedModels:['test/model'],reservation:{id:'r',maxCostCredits:1}},async(_url,options)=>{
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
