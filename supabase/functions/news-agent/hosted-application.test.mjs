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
