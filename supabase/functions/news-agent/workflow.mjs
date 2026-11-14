import {POLICY_VERSION} from './policy.mjs';
const key=/^[a-f0-9]{64}$/;
export function newShadowRun({runId,scanStartedAt}){
 if(typeof runId!=='string'||!runId.trim()||!Number.isFinite(Date.parse(scanStartedAt)))throw Error('Run identity and fixed scan timestamp required');
 return {runId,scanStartedAt,policyVersion:POLICY_VERSION,revision:0,phase:'scan',cursor:null,candidates:[],decisions:[],publishingEnabled:false};
}
function validState(s){
 try{
  if(!s||s.policyVersion!==POLICY_VERSION||s.publishingEnabled!==false||!Number.isSafeInteger(s.revision)||s.revision<0||typeof s.runId!=='string'||!s.runId.trim()||!Number.isFinite(Date.parse(s.scanStartedAt))||!Array.isArray(s.candidates)||!Array.isArray(s.decisions)||!['scan','review','reviewing','uncertain','complete'].includes(s.phase))return false;
  let last=null;
  for(const c of s.candidates){
   if(!c||!key.test(c.id)||(last!==null&&c.id<=last)||typeof c.discoveryText!=='string'||!c.discoveryText)return false;
   const u=new URL(c.sourceUrl);if(u.protocol!=='https:'||u.username||u.password)return false;last=c.id;
  }
  if(s.cursor!==last||s.decisions.length>s.candidates.length)return false;
  for(let i=0;i<s.decisions.length;i++){
   const d=s.decisions[i];if(!d||d.id!==s.candidates[i].id||!['skip','verify'].includes(d.action)||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000)return false;
  }
  if(s.phase==='scan'&&s.decisions.length!==0)return false;
  if(s.phase==='complete'&&s.decisions.length!==s.candidates.length)return false;
  if(['reviewing','uncertain'].includes(s.phase)){
   if(!Array.isArray(s.activeBatch)||s.activeBatch.length<1||s.activeBatch.length>100||s.activeBatch.some((id,i)=>id!==s.candidates[s.decisions.length+i]?.id))return false;
  }else if(s.activeBatch!=null)return false;
  return true;
 }catch{return false;}
}
// A resumable core, not a deployed scheduler. save(next, expectedRevision) MUST be
// durable and atomic CAS. It must reject on lease loss. Never use an upsert.
// review must reserve its request/spend budget before dispatch; no retries here.
export async function advanceShadowRun(previous,{save,fetchPage,review},{pageSteps=1,reviewBatchSize=25}={}){
 if(!validState(previous)||typeof save!=='function')throw Error('Invalid run state');
 if(!Number.isSafeInteger(pageSteps)||pageSteps<1||pageSteps>10||!Number.isSafeInteger(reviewBatchSize)||reviewBatchSize<1||reviewBatchSize>100)throw Error('Invalid invocation bounds');
 let state=structuredClone(previous);
 const persist=async(patch)=>{const next={...state,...patch,revision:state.revision+1};await save(next,state.revision);state=next;};
 if(['uncertain','reviewing'].includes(state.phase))throw Error('Run needs manual reconciliation; no automatic request retry');
 if(state.phase==='complete')return state;
 if(state.phase==='scan'){
  for(let step=0;step<pageSteps;step++){
   const page=await fetchPage({cursor:state.cursor,scanStartedAt:state.scanStartedAt});
   if(!Array.isArray(page)||page.length>100)throw Error('Invalid candidate page');
   if(page.length===0){await persist({phase:'review'});return state;}
   let cursor=state.cursor;const candidates=[];
   for(const c of page){
    if(!c||!key.test(c.id)||cursor!==null&&c.id<=cursor||typeof c.discoveryText!=='string'||!c.discoveryText||typeof c.sourceUrl!=='string')throw Error('Invalid candidate page');
    const u=new URL(c.sourceUrl);if(u.protocol!=='https:'||u.username||u.password)throw Error('Invalid candidate page');
    // Explicit projection excludes labels/metadata; discoveryText stays untrusted data.
    candidates.push({id:c.id,sourceUrl:c.sourceUrl,sourceType:c.sourceType,sourceCreatedAt:c.sourceCreatedAt,discoveryText:c.discoveryText});cursor=c.id;
   }
   await persist({cursor,candidates:[...state.candidates,...candidates]});
  }
  return state;
 }
 if(state.phase!=='review')throw Error('Unknown phase');
 const batch=state.candidates.slice(state.decisions.length,state.decisions.length+reviewBatchSize);
 if(batch.length===0){await persist({phase:'complete'});return state;}
 await persist({phase:'reviewing',activeBatch:batch.map(c=>c.id)});
 try{
  const decisions=await review(structuredClone(batch));
  const expected=new Set(batch.map(c=>c.id)),seen=new Set();
  if(!Array.isArray(decisions)||decisions.length!==batch.length)throw Error('Incomplete model batch');
  for(const d of decisions){
   if(!d||!expected.has(d.id)||seen.has(d.id)||!['skip','verify'].includes(d.action)||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000||Object.keys(d).some(k=>!['id','action','reason'].includes(k)))throw Error('Invalid model decision');
   seen.add(d.id);
  }
  await persist({phase:'review',activeBatch:null,decisions:[...state.decisions,...batch.map(c=>decisions.find(d=>d.id===c.id))]});
 }catch(error){
  // If persisting uncertainty also fails, durable reviewing state still prevents replay.
  try{await persist({phase:'uncertain'});}catch{}
  throw error;
 }
 return state;
}
