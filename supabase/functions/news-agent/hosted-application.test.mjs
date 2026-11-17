import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostedApplication} from './hosted-application.mjs';
const token='synthetic-cron-'.repeat(4),config={projectUrl:'https://fixture.supabase.co',serviceKey:'synthetic-service-key'};
const request=(body='{}',secret=token)=>new Request('https://fixture.invalid/news-agent',{method:'POST',headers:{'x-warpcore-agent-token':secret},body});
function fixture(enabled=true){
 const calls=[];
 const app=createHostedApplication(config,{
  bootstrapRpc:async name=>{calls.push(name);if(name==='warpcore_agent_authorization')return enabled?{enabled:true,producerToken:token}:{enabled:false};return {model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:8192,maxCostCredits:0.076596,allowedSourceHosts:['example.com']};},
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
 for(const status of ['idle','disabled','deferred','submitted','uncertain','busy','verified']){let feedback=0;const calls=[];const app=createHostedApplication(config,{bootstrapRpc:async(name,args)=>{calls.push({name,args});return name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:name==='warpcore_agent_runtime_config'?{model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:8192,maxCostCredits:.076596,allowedSourceHosts:['example.com']}:{enabled:false};},createDiscoveryService:()=>({selectRun:async()=>null}),createVerifierService:()=>({runInvocation:async()=>({status})}),runOwnerFeedbackInvocation:async({db,...rest})=>{feedback++;assert.deepEqual(rest,{});assert.deepEqual(await db.checkpoint(),{enabled:false});return {status:'disabled',privateText:'never expose'};}});const body=await(await app(request())).json();assert.equal(body.status,status);assert.equal(feedback,status==='idle'?1:0);assert.equal(JSON.stringify(body).includes('private'),false);}
});
test('feedback cannot poll on auth/body failures or a progressing discovery run',async()=>{
 let polls=0;const app=createHostedApplication(config,{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:8192,maxCostCredits:.076596,allowedSourceHosts:['example.com']},createDiscoveryService:()=>({selectRun:async()=>'00000000-0000-4000-8000-000000000001',runInvocation:async()=>({status:'advanced',state:{phase:'scan',candidateCount:0,reviewedCount:0}})}),createVerifierService:()=>({runInvocation:async()=>assert.fail()}),runOwnerFeedbackInvocation:()=>{polls++;assert.fail();}});
 assert.equal((await app(request('{}','wrong'))).status,401);assert.equal((await app(request('{"model":"attacker"}'))).status,400);assert.equal((await(await app(request())).json()).mode,'shadow');assert.equal(polls,0);
});
function transportFixture(callback,{feedbackResponse}={}){const requests=[];const app=createHostedApplication(config,{fetcher:async(url,options)=>{requests.push({url:String(url),options});const name=new URL(url).pathname.split('/').at(-1);if(name==='warpcore_agent_authorization')return Response.json({enabled:true,producerToken:token});if(name==='warpcore_agent_runtime_config')return Response.json({model:'openai/gpt-oss-120b',apiKey:'private-test-key',maxOutputTokens:8192,maxCostCredits:.076596,allowedSourceHosts:['example.com']});return feedbackResponse?feedbackResponse(name):Response.json({revision:2,coverage:'pending',newCount:1});},createDiscoveryService:()=>({selectRun:async()=>null}),createVerifierService:()=>({runInvocation:async()=>({status:'idle'})}),runOwnerFeedbackInvocation:callback});return {app,requests};}
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
test('private approved Gemma settings derive exact provider, reservation and batch; forged caps refuse',async()=>{
 for(const [model,cap] of [['google/gemma-4-26b-a4b-it',.036045]])for(const bad of [false,true]){let constructed=0;const app=createHostedApplication(config,{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model,apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:bad?.058983:cap,allowedSourceHosts:['example.com']},createDiscoveryService:options=>{constructed++;assert.equal(options.runtimeConfig.expectedProvider,'PrimeIntellect');assert.equal(options.runtimeConfig.maxCostCredits,cap);assert.equal(options.invocationOptions.reviewBatchSize,16);assert.equal(options.invocationOptions.pageSteps,10);return {selectRun:async()=>null};},createVerifierService:options=>{assert.equal(options.runtimeConfig.model,model);return {runInvocation:async()=>({status:'idle'})};}});const response=await app(request());assert.equal(response.status,bad?502:200);assert.equal(constructed,bad?0:1);}
});
test('hosted discovery and verification share60s model timeout and180s lease margin',async()=>{
 const configs=[];const app=createHostedApplication(config,{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'google/gemma-4-26b-a4b-it',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.036045,allowedSourceHosts:['ir.amd.com']},createDiscoveryService:options=>{configs.push(options.runtimeConfig);return {selectRun:async()=>null};},createVerifierService:options=>{configs.push(options.runtimeConfig);return {runInvocation:async()=>({status:'deferred'})};}});assert.equal((await app(request())).status,200);assert.equal(configs.length,2);for(const cfg of configs){assert.equal(cfg.timeoutMs,60000);assert.equal(cfg.leaseSeconds,180);assert.equal(cfg.model,'google/gemma-4-26b-a4b-it');assert.equal(cfg.maxCostCredits,.036045);}
});

test('drain processes review, completion and verification without another timer; stops on idle',async()=>{
 let calls=0,selected=0;
 const app=createHostedApplication({...config,drain:true},{bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'google/gemma-4-26b-a4b-it',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.036045,allowedSourceHosts:['example.com']},createDiscoveryService:()=>({selectRun:async()=>selected++<2?'11111111-1111-4111-8111-111111111111':null,runInvocation:async()=>({status:'advanced',state:{phase:++calls===1?'review':'complete',candidateCount:2,reviewedCount:2}})}),createVerifierService:()=>({runInvocation:async()=>({status:++calls===3?'submitted':'idle'})})});
 const response=await app(request()),body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.steps.map(x=>x.status),['advanced','advanced','submitted','idle']);assert.equal(body.status,'idle');
});
test('drain does not start another step after10s or replay deferred work',async()=>{
 for(const status of ['advanced','deferred']){
 let calls=0,clock=0;const app=createHostedApplication({...config,drain:true},{now:()=>clock,bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'google/gemma-4-26b-a4b-it',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.036045,allowedSourceHosts:['example.com']},createDiscoveryService:()=>({selectRun:async()=>'11111111-1111-4111-8111-111111111111',runInvocation:async()=>{calls++;clock=40000;return {status,state:{phase:'review',candidateCount:16,reviewedCount:16}};}})});assert.equal((await app(request())).status,200);assert.equal(calls,1);
 }
});

function drainingVerifier(results,now=()=>0){
 let calls=0;const app=createHostedApplication({...config,drain:true},{now,bootstrapRpc:async name=>name==='warpcore_agent_authorization'?{enabled:true,producerToken:token}:{model:'google/gemma-4-26b-a4b-it',apiKey:'private-test-key',maxOutputTokens:4096,maxCostCredits:.036045,allowedSourceHosts:['example.com']},createDiscoveryService:()=>({selectRun:async()=>null}),createVerifierService:()=>({runInvocation:async()=>{calls++;return results[Math.min(calls-1,results.length-1)];}})});return {app,calls:()=>calls};
}
test('finished item deferrals advance to the next queued story in the same invocation',async()=>{
 for(const reason of ['evidence_or_history_unavailable','unapproved_primary_source','model_deferred','billed_invalid_completion','verification_post_unpublishable']){
  const f=drainingVerifier([{status:'deferred',reason},{status:'submitted'},{status:'idle'}]);const r=await f.app(request()),body=await r.json();assert.equal(r.status,200);assert.equal(f.calls(),3);assert.deepEqual(body.steps.map(s=>s.status),['deferred','submitted','idle']);
 }
});
test('unconfirmed completion, infrastructure errors and handoff holds never advance',async()=>{
 for(const reason of ['claim_unavailable','invalid_configuration','handoff_deferred','finish_unconfirmed','reservation_unconfirmed','dispatch_unconfirmed','settlement_unconfirmed','paid_outcome_unknown','receipt_unconfirmed'])for(const status of ['deferred','uncertain']){
  const f=drainingVerifier([{status,reason},{status:'submitted'}]);await f.app(request());assert.equal(f.calls(),1,reason);
 }
});
test('skip-heavy queue still obeys twelve-step and elapsed-time bounds',async()=>{
 const f=drainingVerifier([{status:'deferred',reason:'evidence_or_history_unavailable'}]);const body=await(await f.app(request())).json();assert.equal(f.calls(),12);assert.equal(body.steps.length,12);
 let reads=0;const slow=drainingVerifier([{status:'deferred',reason:'evidence_or_history_unavailable'},{status:'submitted'}],()=>reads++?11000:0);await slow.app(request());assert.equal(slow.calls(),1,'Remaining work stays queued when safe admission window ends');
});
