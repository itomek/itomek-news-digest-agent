import test from 'node:test';import assert from 'node:assert/strict';
import {createAgentService} from './services.mjs';
const projectUrl='https://fixture.supabase.co',serviceKey='synthetic-service-key',run='00000000-0000-4000-8000-000000000111';
test('disabled service performs no database or model network calls',async()=>{
 let calls=0;const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:false}},async()=>{calls++;throw Error();});
 assert.equal(await service.selectRun(),null);assert.equal((await service.runInvocation(run)).status,'disabled');assert.equal(calls,0);
});
test('server-owned selector calls one pinned RPC and refuses redirected or untrusted origin',async()=>{
 assert.throws(()=>createAgentService({projectUrl:'https://evil.example',serviceKey,runtimeConfig:{enabled:true}}));
 let calls=0;const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async(url,opts)=>{
  calls++;assert.equal(String(url),'https://fixture.supabase.co/rest/v1/rpc/warpcore_shadow_select_run');assert.equal(opts.redirect,'error');assert.equal(opts.method,'POST');assert.deepEqual(JSON.parse(opts.body),{});assert.equal(opts.headers.Authorization,`Bearer ${serviceKey}`);return Response.json(run);
 });assert.equal(await service.selectRun(),run);assert.equal(calls,1);
});
test('database failures are bounded and sanitized',async()=>{
 const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>new Response(serviceKey,{status:500}));
 await assert.rejects(()=>service.selectRun(),e=>!e.message.includes(serviceKey));
 const huge=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>new Response('x'.repeat(2100000)));
 await assert.rejects(()=>huge.selectRun());
});
test('invalid selector identity fails before any model transport',async()=>{
 const service=createAgentService({projectUrl,serviceKey,runtimeConfig:{enabled:true}},async()=>Response.json({model:'caller-model'}));await assert.rejects(()=>service.selectRun());
});
