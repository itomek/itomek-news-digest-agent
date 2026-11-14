import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewWithOpenRouter} from './openrouter.mjs';
const request=()=>({model:'test/model',max_tokens:100,temperature:0,messages:[{role:'system',content:'Review only'},{role:'user',content:JSON.stringify({candidates:[{id:'a'}]})}],response_format:{type:'json_object'}});
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
 const request={model:'test/model',max_tokens:100,temperature:0,messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify({candidates:[{id:'one'}]})}],response_format:{type:'json_object'}};
 await assert.rejects(reviewWithOpenRouter(request,{enabled:true,apiKey:'offline',allowedModels:['test/model'],reservation:{id:'r',maxCostCredits:1}},async(_url,options)=>{
  signal=options.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429});
 }));
 assert.equal(cancelled,true);assert.equal(signal.aborted,true);
});
test('declared oversized body is cancelled before reading',async()=>{
 let cancelled=false;
 const request={model:'test/model',max_tokens:100,temperature:0,messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify({candidates:[{id:'one'}]})}],response_format:{type:'json_object'}};
 await assert.rejects(reviewWithOpenRouter(request,{enabled:true,apiKey:'offline',allowedModels:['test/model'],reservation:{id:'r',maxCostCredits:1},maxResponseBytes:10},async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'999'}})));
 assert.equal(cancelled,true);
});
