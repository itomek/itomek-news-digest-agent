import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
globalThis.crypto??=webcrypto;
import {handleAgent} from './handler.mjs';
const token='x'.repeat(40);
async function entry(flag,{bootstrap=false}={}){
 const env={WARPCORE_AGENT_ENABLED:flag,WARPCORE_AGENT_CRON_TOKEN:bootstrap?undefined:token};let handler,calls=0;
 const source=(await fs.readFile(new URL('./index.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/:ReturnType<typeof createAgentService>/g,'').replace(/:Request/g,'').replace(/:string/g,'');
 vm.runInNewContext(source,{Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},handleAgent,createVerificationService:()=>{throw Error("unexpected verifier construction");},createHostedApplication:()=>{calls++;return async()=>Response.json({mode:'disabled'});},createAgentService:()=>{calls++;return {selectRun:async()=>null};}});
 return {request:body=>handler(new Request('https://example.test',{method:'POST',headers:{'x-warpcore-agent-token':token},body})),bad:()=>handler(new Request('https://example.test',{method:'POST',headers:{'x-warpcore-agent-token':'wrong'},body:'{}'})),calls:()=>calls};
}
test('server environment alone enables entrypoint; auth/body refusals construct no service',async()=>{
 for(const flag of [undefined,'false','TRUE','1']){const app=await entry(flag);assert.equal((await (await app.request('{}')).json()).mode,'disabled');assert.equal(app.calls(),0);assert.equal((await app.bad()).status,401);}
 const app=await entry('true');assert.equal((await app.bad()).status,401);assert.equal((await app.request('{"enabled":true,"model":"attacker"}')).status,400);assert.equal(app.calls(),0);assert.equal((await (await app.request('{}')).json()).mode,'idle');assert.equal(app.calls(),1);
});
test('new deployment without legacy token uses one cached database-gated application',async()=>{
 const app=await entry(undefined,{bootstrap:true});
 assert.equal((await (await app.request('{}')).json()).mode,'disabled');
 assert.equal((await (await app.request('{}')).json()).mode,'disabled');
 assert.equal(app.calls(),1);
});
