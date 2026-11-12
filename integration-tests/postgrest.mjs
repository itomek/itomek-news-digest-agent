import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {Client} from 'pg';
import {databaseAdapter} from '../supabase/functions/_shared/adapters.mjs';
const dbUrl=new URL(process.env.WARPCORE_TEST_DATABASE_URL ?? '');
if(dbUrl.hostname!=='127.0.0.1'||dbUrl.pathname!=='/warpcore_test')throw Error('Dedicated loopback test DB required');
const client=new Client({connectionString:dbUrl.toString()});
const secret=process.env.WARPCORE_TEST_JWT_SECRET;
if(!secret||secret.length<32)throw Error('Disposable test JWT secret required');
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const payload=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'service_role',exp:Math.floor(Date.now()/1000)+300});
const token=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
const base='http://127.0.0.1:3000';
const localFetch=async(url,options)=>{assert.equal(url.hostname,'example.supabase.co');return fetch(base+url.pathname.replace(/^\/rest\/v1/,'')+url.search,options);};
const db=databaseAdapter({projectUrl:'https://example.supabase.co',serviceKey:token},localFetch);
try{
 await client.connect();await client.query("notify pgrst, 'reload schema'");
 let ready=false;for(let i=0;i<40;i++){try{const res=await fetch(base+'/rpc/warpcore_ingest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"items":[]}'});if(res.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 assert.equal(ready,true,'PostgREST must expose schema to isolated service role');
 const did='did:plc:abcdefghijklmnopqrstuvwx',key='c'.repeat(64);
 await client.query("insert into warpcore_stories(story_key) values ($1)",[key]);
 const job={accountDid:did,storyKey:key,contentHash:'synthetic-hash',recordKey:'story-'+key,record:{$type:'app.bsky.feed.post',text:'Synthetic API fixture',createdAt:'2026-11-12T12:00:00Z'}};
 assert.equal(await db.prepare(job),true);
 assert.equal(await db.claim(job),null,'unapproved exact record cannot claim');
 assert.equal(await db.review(job,true),true);
 const pending=await db.pending(did);assert.ok(pending.some(r=>r.storyKey===key),'embedded relationship and approved filters work');
 const claimed=await db.claim(job);assert.deepEqual(claimed.record,job.record);assert.equal(await db.claim(job),null);
 await db.uncertain(claimed);await db.checked(claimed);assert.equal(await db.published(claimed,'at://wrong'),false);
 assert.equal(await db.published(claimed,`at://${did}/app.bsky.feed.post/${job.recordKey}`),true);
 const denied=await fetch(base+'/warpcore_publications');assert.ok([401,403].includes(denied.status),'anonymous ledger read denied');
 const deniedRpc=await fetch(base+'/rpc/warpcore_review_publication',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_account:did,p_story:key,p_hash:job.contentHash,p_record:job.record,p_approve:true})});
 assert.ok([401,403,404].includes(deniedRpc.status),'anonymous approval denied');
 console.log('PASS: real PostgREST RPC shape, relationship filters, exact approval, claims, guarded state transitions and anonymous denial');
}finally{await client.end();}
