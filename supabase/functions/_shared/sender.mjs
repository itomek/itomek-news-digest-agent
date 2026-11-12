// Dependency-injected sender; not imported by any deployed endpoint.
// db must provide atomic claim, durable uncertain, and published transitions.
// remote must be an authorized pinned-account transport; tests use mocks only.
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
export async function reconcile(job,db,remote){
 try {
  const found=await remote.get(job.accountDid,job.recordKey);
  if(!found || stable(found.record)!==stable(job.record))return {state:'manual_review'};
  const uri=`at://${job.accountDid}/app.bsky.feed.post/${job.recordKey}`;
  if(await db.published(job,uri)!==true)return {state:'manual_review'};
  return {state:'published',uri};
 }catch{return {state:'uncertain'};}
}
export async function sendPrepared(job,db,remote,policy){
 if(policy?.enabled!==true || policy.accountDid!==job.accountDid)throw Error('Publication disabled or wrong account');
 const stored=await db.claim(job);
 if(!stored)return {state:'not_claimed'};
 // Claim returns immutable persisted record, key and identity, not a boolean.
 job=stored;
 if(policy.accountDid!==job.accountDid)throw Error('Claim returned wrong account');
 // Durable pessimistic state before any network write. Failure here means no send.
 await db.uncertain(job);
 try{
  const receipt=await remote.put(job.accountDid,job.recordKey,job.record,{swapRecord:null});
  const expected=`at://${job.accountDid}/app.bsky.feed.post/${job.recordKey}`;
  if(receipt?.uri!==expected)return {state:'uncertain'};
 }catch{return {state:'uncertain'};}
 // Never trust a write receipt alone; read back exact persisted payload.
 return reconcile(job,db,remote);
}
