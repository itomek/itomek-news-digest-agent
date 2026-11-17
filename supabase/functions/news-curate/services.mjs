import {readJson} from '../_shared/adapters.mjs';
import {createReviewPacket,approveReview} from '../_shared/curation.mjs';
import {prepareTransport} from '../_shared/transport.mjs';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function validateConfig(config){const dot=typeof config.dotId==='string'&&config.dotId.trim()&&config.dotId.length<=128;const agent=config.agentId==='warpcore-news-agent-v1';if(!/^did:plc:[a-z2-7]{24}$/.test(config.accountDid)||!dot||(config.agentId!==undefined&&!agent))throw Error('Pinned account and truthful actor identity required');}
// Trusted connector submissions only. Source text cannot provide its own attestations.
// Sequential bounded DB-only drain; no model, login or public transport.
export async function drainOne(config,db,now){return drain(config,db,1,now);}
export async function drainBatch(config,db,now){return drain(config,db,5,now);}
async function drain(config,db,limit,now){
 validateConfig(config);
 const rows=await db.claim(limit);
 if(!Array.isArray(rows)||rows.length>limit)throw Error('Invalid bounded inbox claim');
 const results=[];
 for(const row of rows)results.push(...await processRow(config,db,row,now??Date.now()));
 return results;
}
async function processRow(config,db,row,now){
 if(!row||!uuid(row.id)||!uuid(row.lease_token))throw Error('Invalid lease identity');
 const reject=async reason=>{try{return [{state:await db.fail(row,reason)===true?'rejected':'conflict'}];}catch{return [{state:'failure_recording_uncertain'}];}};
 const actorValid=row.actor_kind==='dot'?typeof config.dotId==='string'&&row.dot_id===config.dotId&&row.agent_id==null&&row.verification_receipt_id==null:row.actor_kind==='agent'&&config.agentId==='warpcore-news-agent-v1'&&row.agent_id===config.agentId&&row.dot_id==null&&uuid(row.verification_receipt_id);
 if(!actorValid||!uuid(row.run_id)||!Number.isFinite(Date.parse(row.lease_expires_at))||Date.parse(row.lease_expires_at)<=now||!Number.isFinite(Date.parse(row.created_at))||Date.parse(row.created_at)>now+300000||!/^([a-f0-9]{64})$/.test(row.story_key)||!/^[a-f0-9]{64}$/.test(row.evidence_hash))return reject('invalid_submission');
 if(!row.attestations||row.attestations.factsVerified!==true||row.attestations.meaningfulChange!==true||row.attestations.scopeApproved!==true||Object.keys(row.attestations).some(k=>!['factsVerified','meaningfulChange','scopeApproved'].includes(k)))return reject('invalid_attestations');
 if(row.actor_kind==='agent'){
  let receipt;try{receipt=await db.receipt(row.verification_receipt_id);}catch{return [{state:'verification_deferred'}];}
  const m=receipt?.material,j=m?.judgment;
  if(!receipt||receipt.id!==row.verification_receipt_id||!/^([a-f0-9]{64})$/.test(receipt.receiptHash)||receipt.current!==true
  ||!Number.isFinite(Date.parse(receipt.issuedAt))||Date.parse(receipt.issuedAt)>now+300000
  ||!Number.isFinite(Date.parse(receipt.expiresAt))||Date.parse(receipt.expiresAt)<=now
  ||Date.parse(receipt.expiresAt)-Date.parse(receipt.issuedAt)>3600000
  ||m?.version!=='agent-verification-v1'||m?.agentId!==config.agentId||m?.runId!==row.run_id||m?.storyKey!==row.story_key||m?.evidenceHash!==row.evidence_hash
  ||!equal(m?.editorial,row.editorial)||!equal(receipt.evidence,row.evidence)
  ||j?.method!=='model-supported-primary-evidence'||j?.factsSupported!==true||j?.scopeApproved!==true||j?.meaningfulChange!==true||j?.dedupClear!==true
  ||!/^[a-f0-9]{64}$/.test(j?.historyHash))return reject('stale_verification_receipt');
 }
 let current;
 try{current=await db.snapshot(row.story_key);}catch{return [{state:'verification_deferred'}];}
 // Hash is opaque PostgreSQL canonical-JSONB SHA, never recomputed with JS JSON.
 if(!current||current.story_key!==row.story_key||current.evidence_hash!==row.evidence_hash||!equal(current.evidence,row.evidence))return reject('stale_evidence');
 // Do not rewrite a persisted snapshot before SQL's exact-evidence comparison.
 // Legacy/manual noncanonical rows must be repaired/recurated, not auto-retried.
 try{
  if(!Array.isArray(row.evidence))throw Error();
  for(const e of row.evidence){
   if(!e||!Array.isArray(e.sourceLinks))throw Error();
   const links=[e.url,...e.sourceLinks,...(e.nativeUrl==null?[]:[e.nativeUrl])];
   for(const raw of links){
    if(typeof raw!=='string')throw Error();
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.toString()!==raw)throw Error();
   }
  }
 }catch{return reject('noncanonical_evidence');}
 let packet,job;
 try{
  packet=await createReviewPacket({storyKey:row.story_key,evidence:row.evidence,editorial:row.editorial});
  const approved=await approveReview(packet,{...row.attestations,contentHash:packet.contentHash});
  const prepared=await prepareTransport(approved,config.accountDid,row.created_at);
  job={...prepared,storyKey:row.story_key};
 }catch{return reject('invalid_editorial');}
 // SQL must atomically recheck lease, current evidence, exact packet and job;
 // it records the original actor/run/receipt from the immutable inbox.
 try{return [{state:await db.finalize(row,packet,job)===true?'approved':'conflict'}];}
 catch{return [{state:'finalization_uncertain'}];} // Never blindly retry/fail a possibly committed transaction.
}
// Receipt material includes bounded captured source bodies (up to 2MB) plus
// the <=200KB frozen SQL snapshot; ordinary curator RPCs keep their old bound.
async function readReceipt(response){
 if(!response.ok||!response.body)throw Error('Receipt lookup failed');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2500000)throw Error('Receipt response too large');chunks.push(value);}
  const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{await reader.cancel();}
}
export function createCuratorService(config,fetcher=fetch){
 validateConfig(config);
 const project=new URL(config.projectUrl);
 if(project.protocol!=='https:'||!project.hostname.endsWith('.supabase.co')||project.username||project.password||project.port||!config.serviceKey)throw Error('Invalid database configuration');
 const rpc=async(name,body)=>readJson(await fetcher(new URL('/rest/v1/rpc/warpcore_curator_'+name,project),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const fetchReceipt=async id=>await fetcher(new URL('/rest/v1/rpc/warpcore_agent_receipt',project),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify({p_receipt:id})});
 const db={
  receipt:async id=>readReceipt(await fetchReceipt(id)),
  claim:limit=>rpc('claim',{p_limit:limit}),
  snapshot:story=>rpc('snapshot',{p_story:story}),
  finalize:(row,packet,job)=>rpc('finalize',{p_id:row.id,p_lease_token:row.lease_token,p_packet:packet,p_job:job}),
  fail:(row,reason)=>rpc('fail',{p_id:row.id,p_lease_token:row.lease_token,p_reason:reason}),
 };
 return {drain:()=>drainBatch(config,db)};
}
