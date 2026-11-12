// Disposable loopback integration only. No real secrets, publication, or source access.
import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import fs from 'node:fs/promises';import {Client} from 'pg';
import {createCuratorService} from '../supabase/functions/news-curate/services.mjs';
const dbUrl=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(dbUrl.hostname!=='127.0.0.1'||dbUrl.pathname!=='/warpcore_test')throw Error('Dedicated loopback test DB required');
const secret=process.env.WARPCORE_TEST_JWT_SECRET;if(!secret||secret.length<32)throw Error('Disposable test secret required');
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const p=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'service_role',exp:Math.floor(Date.now()/1000)+300});const token=p+'.'+createHmac('sha256',secret).update(p).digest('base64url');
const client=new Client({connectionString:dbUrl.toString()}),base='http://127.0.0.1:3000';
const localFetch=(url,opts)=>{assert.equal(url.hostname,'example.supabase.co');return fetch(base+url.pathname.replace(/^\/rest\/v1/,'')+url.search,opts);};
try{
 await client.connect();await client.query(await fs.readFile(new URL('../supabase/migrations/20261112175929_warpcore_curator_inbox.sql',import.meta.url),'utf8'));await client.query("notify pgrst, 'reload schema'");
 let ready=false;for(let i=0;i<40;i++){const r=await fetch(base+'/rpc/warpcore_curator_snapshot',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({p_story:'f'.repeat(64)})});if(r.ok){ready=true;break;}await new Promise(r=>setTimeout(r,500));}assert.ok(ready);
 const story='7'.repeat(64),uri='fixture:curator-api',url='https://example.com/new-release',dot='test-dot',run='00000000-0000-4000-8000-000000000077';
 await client.query('select warpcore_ingest($1::jsonb)',[JSON.stringify([{uri,story_key:story,source_type:'rss',source_id:'fixture',actor:'fixture',text:'A new release adds useful support.',source_created_at:new Date().toISOString(),source_url:url,source_links:[url]}])]);
 const snapshot=(await client.query('select warpcore_curator_snapshot($1) s',[story])).rows[0].s;
 const editorial={summary:'A new release expands support.',whyItMatters:'More users can run it.',change:'New availability',political:false,evidenceIds:[uri],verification:{checkedAt:new Date().toISOString(),sourceUrls:[url],reason:'Primary synthetic fixture verified; relevant capability release.'}};
 const args=[story,snapshot.evidence_hash,editorial,{factsVerified:true,meaningfulChange:true,scopeApproved:true},dot,run];
 const id=(await client.query('select warpcore_curator_submit($1,$2,$3,$4,$5,$6) id',args)).rows[0].id;
 assert.equal((await client.query('select warpcore_curator_submit($1,$2,$3,$4,$5,$6) id',args)).rows[0].id,id);
 const svc=createCuratorService({projectUrl:'https://example.supabase.co',serviceKey:token,accountDid:'did:plc:pfq2p7n2oiiy2k4pv6xnsgdk',dotId:dot},localFetch);
 assert.deepEqual(await svc.drain(),[{state:'approved'}]);assert.deepEqual(await svc.drain(),[]);
 const inbox=(await client.query('select state,dot_id,run_id,submitted_db_role from warpcore_curator_inbox where id=$1',[id])).rows[0];assert.equal(inbox.state,'processed');assert.equal(inbox.dot_id,dot);assert.equal(inbox.run_id,run);assert.equal(inbox.submitted_db_role,'postgres');
 const publication=(await client.query('select state,record_payload,approved_at from warpcore_publications where story_key=$1',[story])).rows[0];assert.equal(publication.state,'prepared');assert.ok(publication.approved_at);assert.ok(publication.record_payload.text.includes(url));
 for(const path of ['/warpcore_curator_inbox','/rpc/warpcore_curator_claim']){const r=await fetch(base+path,path.includes('/rpc/')?{method:'POST',headers:{'Content-Type':'application/json'},body:'{"p_limit":1}'}:{});assert.ok([401,403,404].includes(r.status));}
 const denied=await fetch(base+'/rpc/warpcore_curator_submit',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({p_story:story,p_evidence_hash:snapshot.evidence_hash,p_editorial:editorial,p_attestations:args[3],p_dot_id:dot,p_run_id:run})});assert.ok([401,403,404].includes(denied.status),'worker cannot impersonate management submission');
 console.log('PASS: actual PostgREST curator snapshot, claim, frozen finalize, audit, idempotency and denied public/worker submission; no post');
}finally{await client.end();}
