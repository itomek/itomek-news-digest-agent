import test from 'node:test';import assert from 'node:assert/strict';
import {createGmailFailureNotifier} from './gmail-alerts.mjs';
const secret='abcdefghijklmnop',failure={httpStatus:502,steps:[{mode:'verification',status:'uncertain',reason:'paid_outcome_unknown'}]};
test('missing or malformed private credential is explicitly unconfigured',async()=>{
 for(const password of [undefined,'','   ','wrong\nsecret','short']){let calls=0;const notify=createGmailFailureNotifier({account:'fixture.owner@gmail.com',password,createTransport:()=>{calls++;throw Error();}});assert.deepEqual(await notify(failure),{status:'unconfigured'});assert.equal(calls,0);}
});
test('Gmail transport uses fixed account/TLS and sends only public failure codes',async()=>{
 let config,mail,closed=0;
 const notify=createGmailFailureNotifier({account:'fixture.owner@gmail.com',password:'abcd efgh ijkl mnop',createTransport:options=>{config=options;return {sendMail:async message=>{mail=message;return {accepted:['fixture.owner@gmail.com']};},close:()=>closed++};}});
 assert.deepEqual(await notify({...failure,to:'attacker@example.com',from:'attacker@example.com',subject:secret,steps:[...failure.steps,{mode:secret,status:secret,reason:secret,error:secret,body:'Private story body',apiKey:secret},{mode:'shadow',error:'agent_run_failed'}]}),{status:'sent'});
 assert.equal(config.host,'smtp.gmail.com');assert.equal(config.port,465);assert.equal(config.secure,true);assert.deepEqual(config.auth,{user:'fixture.owner@gmail.com',pass:secret});assert.equal(config.tls.rejectUnauthorized,true);assert.equal(config.tls.minVersion,'TLSv1.2');assert.equal(config.pool,false);assert.equal(config.disableFileAccess,true);assert.equal(config.disableUrlAccess,true);
 assert.equal(mail.from,'fixture.owner@gmail.com');assert.equal(mail.to,'fixture.owner@gmail.com');assert.equal(mail.subject,'Warp Core processing failure');assert.match(mail.text,/HTTP 502/);assert.match(mail.text,/Time: \d{4}-\d{2}-\d{2}T/);assert.match(mail.text,/provider result or cost could not be confirmed/);assert.match(mail.text,/affected item is retained/);assert.match(mail.text,/paid_outcome_unknown/);assert.match(mail.text,/agent_run_failed/);assert.equal(JSON.stringify(mail).includes(secret),false);assert.equal(JSON.stringify(mail).includes('Private story body'),false);assert.equal(JSON.stringify(mail).includes('attacker'),false);assert.equal(closed,1);
});
test('normal model/editorial deferrals and successful or idle steps send no email',async()=>{
 let calls=0;const notify=createGmailFailureNotifier({account:'fixture.owner@gmail.com',password:secret,createTransport:()=>{calls++;throw Error();}});
 for(const reason of ['model_deferred','unsupported_verification','unapproved_primary_source'])assert.deepEqual(await notify({httpStatus:200,steps:[{mode:'verification',status:'deferred',reason}]}),{status:'suppressed'});
 for(const status of ['idle','busy','advanced','submitted','verified','disabled'])assert.deepEqual(await notify({httpStatus:200,steps:[{status,privateError:secret}]}),{status:'suppressed'});
 assert.deepEqual(await notify({httpStatus:401,steps:[{error:'invalid_agent_request'}]}),{status:'suppressed'});assert.equal(calls,0);
});
test('SMTP construction/send/close failures never escape or expose the password',async()=>{
 assert.deepEqual(await createGmailFailureNotifier({account:'fixture.owner@gmail.com',password:secret,createTransport:()=>{throw Error(secret);}})(failure),{status:'failed'});
 let closed=0;const notify=createGmailFailureNotifier({account:'fixture.owner@gmail.com',password:secret,createTransport:()=>({sendMail:async()=>{throw Error(secret);},close:()=>{closed++;throw Error(secret);}})});
 assert.deepEqual(await notify(failure),{status:'failed'});assert.equal(closed,1);
});
test('a hanging SMTP operation is bounded and its transport is closed',async()=>{
 let closed=0;const started=performance.now();const notify=createGmailFailureNotifier({account:'fixture.owner@gmail.com',password:secret,timeoutMs:5,createTransport:()=>({sendMail:()=>new Promise(()=>{}),close:()=>closed++})});
 assert.deepEqual(await notify(failure),{status:'timeout'});assert.equal(closed,1);assert.ok(performance.now()-started<1000);
});

test('deployed entrypoint pins Nodemailer and wires only the private Gmail secret',async()=>{
 const {default:fs}=await import('node:fs/promises'),{default:vm}=await import('node:vm');
 const entry=await fs.readFile(new URL('./index.ts',import.meta.url),'utf8');assert.match(entry,/from 'npm:nodemailer@10\.6\.0'/);
 const source=entry.replace(/^import .*;\n/gm,'').replace(/:ReturnType<typeof createAgentService>/g,'').replace(/:Request/g,'').replace(/:string/g,'').replace(/:unknown/g,'');
 let handler,dependencies,smtp;const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',WARPCORE_ALERT_GMAIL_USERNAME:'fixture.owner@gmail.com',WARPCORE_ALERT_GMAIL_APP_PASSWORD:secret};
 vm.runInNewContext(source,{Deno:{env:{get:key=>env[key]},serve:fn=>handler=fn},createGmailFailureNotifier,
  nodemailer:{createTransport:options=>{smtp=options;return {sendMail:async()=>({accepted:['fixture.owner@gmail.com']}),close:()=>{}};}},
  createHostedApplication:(_config,deps)=>{dependencies=deps;return async()=>new Response('{}');},
  createVerificationService:()=>{},runOwnerFeedbackInvocation:()=>{},Response});
 await handler(new Request('https://example.test',{method:'POST'}));
 assert.equal(typeof dependencies.notifyFailure,'function');assert.deepEqual(await dependencies.notifyFailure(failure),{status:'sent'});assert.equal(smtp.auth.pass,secret);
 delete env.WARPCORE_ALERT_GMAIL_APP_PASSWORD;assert.deepEqual(await dependencies.notifyFailure(failure),{status:'unconfigured'});
});
