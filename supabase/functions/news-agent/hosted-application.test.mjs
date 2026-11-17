import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostedApplication} from './hosted-application.mjs';
const token='synthetic-cron-'.repeat(4),config={projectUrl:'https://fixture.supabase.co',serviceKey:'synthetic-service-key'};
const request=(body='{}',secret=token)=>new Request('https://fixture.invalid/news-agent',{method:'POST',headers:{'x-warpcore-agent-token':secret},body});
function fixture(enabled=true){
 const calls=[];
 const app=createHostedApplication(config,{
  bootstrapRpc:async name=>{calls.push(name);if(name==='warpcore_agent_authorization')return enabled?{enabled:true,producerToken:token}:{enabled:false};return {model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:0.058983,allowedSourceHosts:['example.com']};},
  createDiscoveryService:()=>({selectRun:async()=>{calls.push('select');return null;},runInvocation:async()=>assert.fail('no discovery run')}),
  createVerifierService:()=>({runInvocation:async()=>{calls.push('verify');return {status:'verified',privateBody:'must never leave HTTP'};}}),
 });return {app,calls};
}
test('server disabled before key lookup, auth/body refusal before runtime configuration',async()=>{
 const disabled=fixture(false);assert.equal((await (await disabled.app(request())).json()).mode,'disabled');assert.deepEqual(disabled.calls,['warpcore_agent_authorization']);
 for(const req of [request('{}','wrong'),request('{"apiKey":"attacker"}')]){
  const f=fixture();assert.ok([400,401].includes((await f.app(req)).status));assert.deepEqual(f.calls,['warpcore_agent_authorization']);
 }
});
test('authenticated empty trigger loads private settings and runs one verifier after discovery is idle',async()=>{
 const f=fixture(),response=await f.app(request()),body=await response.json();
 assert.deepEqual(body,{mode:'verification',status:'verified',publishing_enabled:false});
 assert.deepEqual(f.calls,['warpcore_agent_authorization','warpcore_agent_runtime_config','select','verify']);
 assert.equal(JSON.stringify(body).includes('private'),false);
});
test('owner feedback runs one callback only after both discovery and verification are idle',async()=>{
 for(const status of ['idle','disabled','deferred','submitted','uncertain','busy','verified']){let feedback=0;const calls=[];const app=createHostedApplication(config,{bootstrapRpc:async(name,args)=>{calls.push({name,args});return name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:name==='warpcore_agent_runtime_config'?{model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.058983,allowedSourceHosts:['example.com']}:{enabled:false};},createDiscoveryService:()=>({selectRun:async()=>null}),createVerifierService:()=>({runInvocation:async()=>({status})}),runOwnerFeedbackInvocation:async({db,...rest})=>{feedback++;assert.deepEqual(rest,{});assert.deepEqual(await db.checkpoint(),{enabled:false});return {status:'disabled',privateText:'never expose'};}});const body=await(await app(request())).json();assert.equal(body.status,status);assert.equal(feedback,status==='idle'?1:0);assert.equal(JSON.stringify(body).includes('private'),false);}
});
test('feedback cannot poll on auth/body failures or a progressing discovery run',async()=>{
 let polls=0;const app=createHostedApplication(config,{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.058983,allowedSourceHosts:['example.com']},createDiscoveryService:()=>({selectRun:async()=>'00000000-0000-4000-8000-000000000001',runInvocation:async()=>({status:'advanced',state:{phase:'scan',candidateCount:0,reviewedCount:0}})}),createVerifierService:()=>({runInvocation:async()=>assert.fail()}),runOwnerFeedbackInvocation:()=>{polls++;assert.fail();}});
 assert.equal((await app(request('{}','wrong'))).status,401);assert.equal((await app(request('{"model":"attacker"}'))).status,400);assert.equal((await(await app(request())).json()).mode,'shadow');assert.equal(polls,0);
});
function transportFixture(callback,{feedbackResponse}={}){const requests=[];const app=createHostedApplication(config,{fetcher:async(url,options)=>{requests.push({url:String(url),options});const name=new URL(url).pathname.split('/').at(-1);if(name==='warpcore_agent_authorization')return Response.json({enabled:true,producerToken:token});if(name==='warpcore_agent_runtime_config')return Response.json({model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.058983,allowedSourceHosts:['example.com']});return feedbackResponse?feedbackResponse(name):Response.json({revision:2,coverage:'pending',newCount:1});},createDiscoveryService:()=>({selectRun:async()=>null}),createVerifierService:()=>({runInvocation:async()=>({status:'idle'})}),runOwnerFeedbackInvocation:callback});return {app,requests};}
test('feedback receives only fixed checkpoint/page RPCs with exact arguments and fixed private transport',async()=>{
 const f=transportFixture(async({db})=>{assert.deepEqual(Object.keys(db).sort(),['checkpoint','recordPage']);await db.checkpoint();await db.recordPage(1,{entries:[]});return {status:'advanced',recordedCount:1,secret:'never expose'};});assert.deepEqual(await(await f.app(request())).json(),{mode:'verification',status:'idle',publishing_enabled:false});const rpc=f.requests.slice(2);assert.equal(rpc.length,2);assert.equal(rpc[0].url,'https://fixture.supabase.co/rest/v1/rpc/warpcore_owner_feedback_checkpoint');assert.equal(rpc[0].options.body,'{}');assert.equal(rpc[1].url,'https://fixture.supabase.co/rest/v1/rpc/warpcore_owner_feedback_record_page');assert.deepEqual(JSON.parse(rpc[1].options.body),{p_revision:1,p_page:{entries:[]}});for(const x of rpc){assert.equal(x.options.headers.Authorization,'Bearer '+config.serviceKey);assert.equal(x.options.redirect,'error');}
});
test('feedback argument, wire-size and response failures remain generic and never leak secrets',async()=>{
 for(const invoke of [db=>db.checkpoint({model:'forbidden'}),db=>db.recordPage(1,{},'extra'),db=>db.recordPage(-1,{}),db=>db.recordPage(1,[]),db=>db.recordPage(1,{text:'x'.repeat(200001)}),db=>db.recordPage(1,{text:'🦀'.repeat(50001)}),async()=>{throw Error('private-test-key '+config.serviceKey);}]){const f=transportFixture(async({db})=>{await invoke(db);return {status:'advanced'};});const response=await f.app(request());assert.equal(response.status,502);assert.equal(JSON.stringify(await response.json()).includes('private'),false);assert.equal(f.requests.length,2);}
 const f=transportFixture(async({db})=>{await db.recordPage(1,{});return {status:'conflict'};});assert.equal((await f.app(request())).status,200);
});

test('feedback response declaration and streamed bytes are bounded to 32KB',async()=>{
 for(const feedbackResponse of [()=>new Response('private-test-key',{headers:{'content-length':'32001'}}),()=>Response.json({privateText:'x'.repeat(32001)}),()=>new Response('secret-body',{status:503})]){const f=transportFixture(async({db})=>{await db.checkpoint();return {status:'advanced'};},{feedbackResponse});const response=await f.app(request());assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'agent_run_failed',publishing_enabled:false});assert.equal(f.requests.length,3);}
});
test('private approved NVIDIA settings derive exact provider, reservation and batch; forged caps refuse',async()=>{
 for(const [model,cap] of [['nvidia/nemotron-3.5-super-vl',.157287],['nvidia/nemotron-3-super-120b-a12b',.026215]])for(const bad of [false,true]){let constructed=0;const app=createHostedApplication(config,{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model,apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:bad?.058983:cap,allowedSourceHosts:['example.com']},createDiscoveryService:options=>{constructed++;assert.equal(options.runtimeConfig.expectedProvider,'DeepInfra');assert.equal(options.runtimeConfig.maxCostCredits,cap);assert.equal(options.invocationOptions.reviewBatchSize,16);return {selectRun:async()=>null};},createVerifierService:options=>{assert.equal(options.runtimeConfig.model,model);return {runInvocation:async()=>({status:'idle'})};}});const response=await app(request());assert.equal(response.status,bad?502:200);assert.equal(constructed,bad?0:1);}
});
