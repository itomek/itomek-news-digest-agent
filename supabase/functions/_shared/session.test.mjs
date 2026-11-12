import test from 'node:test';import assert from 'node:assert/strict';import * as session from './session.mjs';
const did='did:plc:abcdefghijklmnopqrstuvwx';
const config={enabled:true,accountDid:did,identifier:'warp-core.bsky.social',appPassword:'test-only-password'};
const doc={id:did,service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:'https://unit.bsky.network'}]};
test('disabled connection makes no requests',async()=>assert.deepEqual(await session.connect({},()=>{throw Error('network');}),{enabled:false}));
test('public handle and DID resolution precede one credential request; tokens never returned to callers as debug',async()=>{
 const calls=[];const result=await session.connect(config,async(u,o)=>{calls.push(u);assert.equal(o.redirect,'error');if(u.includes('resolveHandle'))return Response.json({did});if(u.includes('plc.directory'))return Response.json(doc);assert.equal(u,'https://unit.bsky.network/xrpc/com.atproto.server.createSession');assert.deepEqual(JSON.parse(o.body),{identifier:did,password:config.appPassword});return Response.json({did,active:true,accessJwt:'fixture-access',refreshJwt:'discard-me'});});
 assert.deepEqual(result,{enabled:true,accountDid:did,pdsUrl:'https://unit.bsky.network',accessToken:'fixture-access'});assert.equal(calls.length,3);
});
test('wrong handle resolution prevents password transmission',async()=>{let calls=0;await assert.rejects(()=>session.connect(config,async()=>{calls++;return Response.json({did:'wrong'});}));assert.equal(calls,1);});
test('untrusted PDS prevents password transmission',async()=>{let calls=0;await assert.rejects(()=>session.connect(config,async()=>{calls++;return Response.json(calls===1?{did}:{...doc,service:[{...doc.service[0],serviceEndpoint:'https://evil.example'}]});}));assert.equal(calls,2);});
test('wrong authenticated identity rejected; no retry on failed login',async()=>{for(const failure of [Response.json({did:'wrong',accessJwt:'x'}),new Response('denied',{status:401})]){let calls=0;await assert.rejects(()=>session.connect(config,async()=>{calls++;return calls===1?Response.json({did}):calls===2?Response.json(doc):failure;}));assert.equal(calls,3);}});
test('password runtime connection supplies only validated ephemeral session to initializer',async()=>{
 let got;const result=await session.initializeWithPassword({...config,projectUrl:'https://project.supabase.co',serviceKey:'fixture'},async c=>{got=c;return {ready:true};},async()=>({enabled:true,accountDid:did,pdsUrl:'https://unit.bsky.network',accessToken:'fixture-access'}));assert.deepEqual(result,{ready:true});assert.equal(got.appPassword,undefined);assert.equal(got.accessToken,'fixture-access');
});
