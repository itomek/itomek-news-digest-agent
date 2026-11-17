import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createVerificationService} from './verification-services.mjs';
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`,story='a'.repeat(64),url='https://ir.amd.com/fixture-release';
const config={projectUrl:'https://fixture.supabase.co',serviceKey:'synthetic-service-key',runtimeConfig:{enabled:true,apiKey:'synthetic-model-key',model:'openai/gpt-oss-120b',allowedModels:['openai/gpt-oss-120b'],expectedProvider:'Cerebras',maxOutputTokens:4096,maxCostCredits:.076596,allowedSourceHosts:['ir.amd.com']}};
test('separate transports receive only their own credentials and fixed RPC bodies',async()=>{
 const events=[];let requestHash;
 const service=createVerificationService(config,{
  rpcFetcher:async(target,options)=>{
   assert.equal(target.origin,'https://fixture.supabase.co');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.headers.apikey,config.serviceKey);assert.equal(options.headers.Authorization,'Bearer '+config.serviceKey);assert.equal(options.body.includes(config.runtimeConfig.apiKey),false);
   const name=target.pathname.split('/').at(-1),body=JSON.parse(options.body);events.push(name);
   if(name==='warpcore_verification_claim'){assert.deepEqual(body,{});return Response.json({jobId:id(1),rankingRunId:id(2),storyKey:story,lease:id(3)});}
   if(name==='warpcore_curator_snapshot'){assert.deepEqual(body,{p_story:story});return Response.json({story_key:story,evidence_hash:'b'.repeat(64),evidence:[{id:'fixture:source',url,text:'Discovery only',sourceType:'rss',visibility:'public',sourceLinks:[url]}]});}
   if(name==='warpcore_agent_history'){assert.deepEqual(body,{p_cursor:null});return Response.json({snapshotHash:'c'.repeat(64),historyCoverageMode:'all-published-plus-unresolved-v1',items:[],cursor:null,complete:true});}
   if(name==='warpcore_verification_reserve'){requestHash=body.p_hash;assert.equal(body.p_max,.076596);assert.equal(body.p_metadata.profileVersion,'2026-11-17.verify.2');return Response.json(id(4));}
   if(name==='warpcore_verification_settle'){assert.equal(body.p_cost,.005);assert.equal(body.p_status,'settled');}
   if(name==='warpcore_verification_finish')assert.equal(body.p_status,'deferred');
   assert.ok(['warpcore_verification_dispatch','warpcore_verification_settle','warpcore_verification_finish'].includes(name));return Response.json(true);
  },
  evidenceFetcher:async(target,options)=>{events.push('source');assert.equal(target,url);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.apikey,undefined);return new Response('Actual captured public source.',{headers:{'content-type':'text/plain'}});},
  modelFetcher:async(target,options)=>{
   events.push('model');assert.equal(target,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+config.runtimeConfig.apiKey);assert.equal(options.body.includes(config.serviceKey),false);assert.equal(createHash('sha256').update(options.body).digest('hex'),requestHash);
   return Response.json({id:'fixture-model-generation',model:config.runtimeConfig.model,provider:'Cerebras',usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:.005},choices:[{finish_reason:'stop',message:{content:JSON.stringify({result:{action:'defer',reason:'Insufficient primary evidence.'}})}}]});
  },
 });
 assert.equal((await service.runInvocation()).status,'deferred');assert.equal(events.filter(e=>e==='model').length,1);assert.ok(events.indexOf('warpcore_verification_dispatch')<events.indexOf('model'));assert.equal(events.at(-1),'warpcore_verification_finish');
});
test('disabled service queues no RPC, evidence or inference',async()=>{
 const nope=()=>{throw Error('must not call');};const service=createVerificationService({...config,runtimeConfig:{...config.runtimeConfig,enabled:false}},{rpcFetcher:nope,modelFetcher:nope,evidenceFetcher:nope});assert.equal((await service.runInvocation()).status,'disabled');
});
test('invalid origins and credential injection are rejected before network',()=>{
 for(const change of [{projectUrl:'http://fixture.supabase.co'},{projectUrl:'https://fixture.supabase.co/path'},{projectUrl:'https://fixture.supabase.co/?key=bad'},{projectUrl:'https://user@fixture.supabase.co'},{projectUrl:'https://evil.example/'},{serviceKey:'bad\nkey'},{serviceKey:''}])assert.throws(()=>createVerificationService({...config,...change}),/Invalid verification database configuration/);
});
test('oversized or invalid RPC JSON is bounded and returns sanitized claim deferral',async()=>{
 for(const response of [()=>new Response('x'.repeat(2500001)),()=>new Response('not-json'),()=>new Response('null',{headers:{'content-length':'2500001'}}),()=>new Response('private database error',{status:500})]){
  const service=createVerificationService(config,{rpcFetcher:async()=>response(),modelFetcher:()=>{throw Error('must not infer');},evidenceFetcher:()=>{throw Error('must not fetch');}});
  const out=await service.runInvocation();assert.deepEqual(out,{status:'deferred',reason:'claim_unavailable',publishingEnabled:false});assert.equal(JSON.stringify(out).includes('private'),false);
 }
});
test('RPC deadline includes a stalled body and causes no inference',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 const service=createVerificationService(config,{rpcFetcher:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),modelFetcher:()=>{throw Error('must not infer');},evidenceFetcher:()=>{throw Error('must not fetch');}});
 const pending=service.runInvocation();await Promise.resolve();await Promise.resolve();t.mock.timers.tick(10000);
 assert.equal((await pending).reason,'claim_unavailable');assert.equal(cancelled,true);t.mock.timers.reset();
});
