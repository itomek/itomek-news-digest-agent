// Real independent PostgreSQL sessions. Runs after curator-postgrest on a disposable loopback fixture.
import {Client} from 'pg';import {createHash,randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';
const url=new URL(process.env.WARPCORE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/warpcore_test')throw Error('Dedicated loopback warpcore_test database required');
const clients=[new Client({connectionString:url.href}),new Client({connectionString:url.href}),new Client({connectionString:url.href})];const[a,b,observer]=clients;let pid;
const attestations={factsVerified:true,meaningfulChange:true,scopeApproved:true},account='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const query=(c,sql,args=[])=>c.query(sql,args);const submit=(c,args)=>query(c,'select warpcore_curator_submit($1,$2,$3,$4,$5,$6) id',args);
async function blocked(){for(let i=0;i<80;i++){if((await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return true;await new Promise(r=>setTimeout(r,25));}return false;}
async function seed(label){const story=createHash('sha256').update('curator-concurrency-'+label).digest('hex'),uri='fixture:curator-concurrency:'+label,link='https://example.com/'+label;
 await a.query('select warpcore_ingest($1::jsonb)',[JSON.stringify([{uri,story_key:story,source_type:'rss',source_id:'fixture',actor:'fixture',text:'Synthetic public release.',source_created_at:new Date().toISOString(),source_url:link,source_links:[link]}])]);
 const snap=(await a.query('select warpcore_curator_snapshot($1) s',[story])).rows[0].s;
 const ed={summary:'A release adds useful support.',whyItMatters:'It improves compatibility.',change:'New release',political:false,evidenceIds:[uri],verification:{checkedAt:new Date().toISOString(),sourceUrls:[link],reason:'Synthetic primary-source verification.'}};
 return {story,uri,snap,ed,args:[story,snap.evidence_hash,ed,attestations,'test-concurrent-dot',randomUUID()]};}
async function frozen(f,row){const packet=await createReviewPacket({storyKey:f.story,evidence:f.snap.evidence,editorial:f.ed});const job={...await prepareTransport({...packet.recordDraft,verified:true,approved:true},account,new Date(row.created_at).toISOString()),storyKey:f.story};return [row.id,row.lease_token,packet,job];}
const finalize=(c,args)=>c.query('select warpcore_curator_finalize($1,$2,$3,$4) ok',args);
try{
 await Promise.all(clients.map(c=>c.connect()));await Promise.all(clients.map(c=>c.query("set statement_timeout='10s'")));pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
 assert.equal((await a.query("select count(*)::int n from warpcore_curator_inbox where state in ('pending','leased')")).rows[0].n,0,'Prior fixture must have drained its queue');
 const f=await seed('same-story');
 await a.query('begin');const id=(await submit(a,f.args)).rows[0].id;
 const second=submit(b,f.args);assert.equal(await blocked(),true,'Duplicate submissions must actually contend');await a.query('commit');assert.equal((await second).rows[0].id,id,'Same submission resumes idempotently');
 assert.equal((await a.query('select count(*)::int n from warpcore_curator_inbox where story_key=$1',[f.story])).rows[0].n,1);
 await a.query('begin');const leased=(await a.query('select * from warpcore_curator_claim(1)')).rows[0];assert.equal(leased.id,id);
 assert.equal((await b.query('select * from warpcore_curator_claim(1)')).rowCount,0,'Concurrent claimant skips locked inbox row');await a.query('commit');
 const args=await frozen(f,leased);await a.query('begin');assert.equal((await finalize(a,args)).rows[0].ok,true);
 const competing=finalize(b,args);assert.equal(await blocked(),true,'Concurrent finalization must block on exact inbox row');await a.query('commit');assert.equal((await competing).rows[0].ok,false,'Finalization loser cannot approve twice');
 assert.equal((await a.query('select count(*)::int n from warpcore_publications where story_key=$1',[f.story])).rows[0].n,1);
 // An in-flight evidence update owns the story lock. Finalizer waits, then sees its committed revision.
 const g=await seed('changed-evidence');await submit(a,g.args);const stale=(await a.query('select * from warpcore_curator_claim(1)')).rows[0];const staleArgs=await frozen(g,stale);
 await a.query('begin');await a.query("update warpcore_candidates set text='Changed public fact.' where uri=$1",[g.uri]);
 const staleFinal=finalize(b,staleArgs);assert.equal(await blocked(),true,'Finalizer waits for in-flight evidence writer');await a.query('commit');assert.equal((await staleFinal).rows[0].ok,false,'Changed evidence invalidates frozen review');
 assert.equal((await a.query('select reason from warpcore_curator_inbox where id=$1',[stale.id])).rows[0].reason,'stale_evidence');assert.equal((await a.query('select count(*)::int n from warpcore_publications where story_key=$1',[g.story])).rows[0].n,0);
 console.log('PASS: real concurrent curator submission serialization, skip-locked claim, exact finalize winner, and evidence-writer/finalizer race; no post');
}finally{await Promise.all(clients.map(c=>c.query('rollback').catch(()=>{})));await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
