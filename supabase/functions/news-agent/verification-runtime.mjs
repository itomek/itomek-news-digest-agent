import {fetchGithubReleaseEvidence} from './github-release-verification.mjs';
import {createReviewPacket,approveReview} from '../_shared/curation.mjs';
import {previewRecord} from '../_shared/publishing.mjs';
import {isApprovedPrimarySourceUrl} from './primary-source-policy.mjs';
import {approvedRuntimeModel,DEFAULT_RUNTIME_MODEL} from './approved-runtime-models.mjs';
import {OpenRouterAttemptError,sanitizedHttpDiagnostics} from './openrouter.mjs';
import {buildVerificationRequest,validateVerificationResult,boundedVerificationAuditResult,VerificationValidationError,VERIFICATION_PUBLIC_REASONS} from './verification-contract.mjs';
import {verifyWithOpenRouter,VERIFICATION_REQUEST_PROFILE_VERSION} from './verification-openrouter.mjs';
import {fetchNativeEvidence} from './native-verification.mjs';
import {fetchCapturedEvidence} from './source-verification.mjs';
import {POLICY_VERSION} from './policy.mjs';
export const VERIFICATION_RESERVATION_CREDITS=approvedRuntimeModel(DEFAULT_RUNTIME_MODEL).maxCostCredits;
const AGENT='warpcore-news-agent-v1';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const encoder=new TextEncoder();
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const project=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]));
const publicFields=(value,keys)=>{const out=project(value,keys);for(const v of Object.values(out))if(v!==null&&(typeof v!=='string'||v.length>20000))throw Error('Invalid public history field');return out;};
const text=x=>typeof x==='string'&&x.trim().length>0;
// Only public editorial/source material enters the prompt. SQL actor, credentials,
// receipts, claims, leases and arbitrary future metadata are never forwarded.
export function projectVerificationHistory(item){
 if(!plain(item)||!['inbox','publication'].includes(item.kind)||!sha(item.storyKey))throw Error('Invalid history');
 const out={kind:item.kind,storyKey:item.storyKey};
 if(plain(item.editorial))out.editorial=publicFields(item.editorial,['summary','whyItMatters','change','mode']);
 if(plain(item.record)){
  out.record=publicFields(item.record,['$type','text','createdAt']);
  if(plain(item.record.subject))out.record.subject=publicFields(item.record.subject,['uri','cid']);
  if(Array.isArray(item.record.facets))out.record.links=item.record.facets.flatMap(f=>Array.isArray(f?.features)?f.features.filter(x=>x?.$type==='app.bsky.richtext.facet#link'&&typeof x.uri==='string').map(x=>x.uri):[]);
 }
 if(!Array.isArray(item.candidateContext)||item.candidateContext.length>20)throw Error('Incomplete history');
 out.candidateContext=item.candidateContext.map(c=>{if(!plain(c))throw Error('Invalid history context');return publicFields(c,['id','text','url','sourceType','nativeUri','nativeCid','sourceCreatedAt']);});
 if(!text(out.editorial?.summary)&&!text(out.editorial?.change)&&!text(out.record?.text)&&!text(out.record?.subject?.uri)&&!out.candidateContext.some(c=>text(c.text)))throw Error('Unusable history');
 return out;
}
async function readHistory(rpc,started){
 const items=[];let cursor=null,snapshotHash;const seen=new Set();
 for(let pageNumber=0;pageNumber<1000;pageNumber++){
  if(Date.now()-started>30000)throw Error('History deadline');
  const page=await rpc('warpcore_agent_history',{p_cursor:cursor});
  if(!plain(page)||!sha(page.snapshotHash)||!Array.isArray(page.items)||page.items.length>50||typeof page.complete!=='boolean'||page.historyCoverageMode!=='all-published-plus-unresolved-v1')throw Error('Incomplete history');
  snapshotHash??=page.snapshotHash;if(snapshotHash!==page.snapshotHash)throw Error('History changed');
  for(const item of page.items)items.push(projectVerificationHistory(item));
  if(encoder.encode(JSON.stringify(items)).length>500000)throw Error('History too large');
  if(page.complete)return {snapshotHash,items,complete:true};
  if(typeof page.cursor!=='string'||!page.cursor||page.cursor===cursor||seen.has(page.cursor)||page.items.length===0)throw Error('History cursor stalled');
  seen.add(page.cursor);cursor=page.cursor;
 }
 throw Error('Incomplete history');
}
function configured(config){
 const approved=approvedRuntimeModel(config?.model);
 return approved&&config?.enabled===true&&config.expectedProvider===approved.provider&&Array.isArray(config.allowedModels)&&config.allowedModels.includes(approved.model)
 &&typeof config.apiKey==='string'&&config.apiKey.trim()&&!/[\r\n]/.test(config.apiKey)&&Number.isFinite(config.maxCostCredits)&&config.maxCostCredits===approved.maxCostCredits
 &&Number.isSafeInteger(config.maxOutputTokens)&&config.maxOutputTokens>0&&config.maxOutputTokens<=approved.maxOutputTokens
 &&Array.isArray(config.allowedSourceHosts)&&config.allowedSourceHosts.length>0&&config.allowedSourceHosts.length<=100
 &&config.allowedSourceHosts.every(h=>typeof h==='string'&&h===h.toLowerCase()&&h.length<=253)
 &&(config.maxResponseBytes===undefined||Number.isSafeInteger(config.maxResponseBytes)&&config.maxResponseBytes>0&&config.maxResponseBytes<=200000)
 &&(config.timeoutMs===undefined||Number.isSafeInteger(config.timeoutMs)&&config.timeoutMs>0&&config.timeoutMs<=30000);
}
const unknownCodes=new Set(['timeout','http_failure','transport_failure','invalid_json','missing_or_invalid_usage','response_too_large','reservation_exceeded','invalid_completion','invalid_verification_json','invalid_verification_schema']);
const billedCodes=new Set(['reservation_exceeded','invalid_completion','invalid_verification_json','invalid_verification_schema']);
const validUsage=u=>plain(u)&&['promptTokens','completionTokens','totalTokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)&&u.promptTokens+u.completionTokens===u.totalTokens&&Number.isFinite(u.costCredits)&&u.costCredits>=0;
const auditIdentity=a=>plain(a)&&['generationId','model','provider'].every(k=>typeof a[k]==='string'&&a[k].trim()===a[k]&&a[k].length>0&&!/\p{Cc}/u.test(a[k]))&&a.generationId.length<=256&&a.model.length<=128&&a.provider.length<=128;
const diagnosticIssues=new Set(['invalid_shape','unexpected_fields','unknown_id','duplicate_id','invalid_action','invalid_reason','invalid_scores']);
function attemptDiagnostic(error,secret){
 if(!(error instanceof OpenRouterAttemptError))return undefined;
 const out=sanitizedHttpDiagnostics(error,secret);for(const [field,max] of [['generationId',256],['model',128],['provider',128]]){const v=error.completionAudit?.[field];if(typeof v==='string'&&v.length>0&&v.length<=max&&v===v.trim()&&!/\p{Cc}/u.test(v)&&!(typeof secret==='string'&&secret&&v.includes(secret)))out[field]=v;}
 if(Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599)out.httpStatus=error.httpStatus;
 if(diagnosticIssues.has(error.validationIssue))out.validationIssue=error.validationIssue;
 if(Number.isInteger(error.decisionIndex)&&error.decisionIndex>=0&&error.decisionIndex<=99)out.decisionIndex=error.decisionIndex;
 return Object.keys(out).length?out:undefined;
}
export async function runVerificationInvocation({config={},rpc,modelFetcher,evidenceFetcher,now=()=>new Date().toISOString()}={}){
 if(config.enabled!==true)return {status:'disabled',publishingEnabled:false};
 if(!configured(config)||typeof rpc!=='function'||typeof modelFetcher!=='function'||typeof evidenceFetcher!=='function')return {status:'deferred',reason:'invalid_configuration',publishingEnabled:false};
 const approved=approvedRuntimeModel(config.model);
 let job;
 try{job=await rpc('warpcore_verification_claim',{});}catch{return {status:'deferred',reason:'claim_unavailable',publishingEnabled:false};}
 if(job===null)return {status:'idle',publishingEnabled:false};
 if(!plain(job)||!uuid(job.jobId)||!uuid(job.rankingRunId)||!uuid(job.lease)||!sha(job.storyKey))return {status:'uncertain',reason:'invalid_claim',publishingEnabled:false};
 const ids={p_job:job.jobId,p_lease:job.lease},flags={jobId:job.jobId,publishingEnabled:false};
 const handoff=async receipt=>{
  try{const inbox=await rpc('warpcore_verification_handoff',ids);if(inbox===null)return {status:'deferred',reason:'handoff_deferred',receiptId:receipt,...flags};if(!uuid(inbox))throw Error();return {status:'submitted',receiptId:receipt,inboxId:inbox,...flags};}
  catch{return {status:'uncertain',reason:'handoff_unconfirmed',receiptId:receipt,...flags};}
 };
 if(Object.hasOwn(job,'handoffReceiptId'))return uuid(job.handoffReceiptId)?handoff(job.handoffReceiptId):{status:'uncertain',reason:'invalid_handoff_claim',...flags};
 const finishDeferred=async reason=>{
  try{if(await rpc('warpcore_verification_finish',{...ids,p_status:'deferred',p_receipt:null})!==true)throw Error();return {status:'deferred',reason,...flags};}
  catch{return {status:'uncertain',reason:'finish_unconfirmed',...flags};}
 };
 let input,request,requestSha256;
 const started=Date.now();
 try{
  const snapshot=await rpc('warpcore_curator_snapshot',{p_story:job.storyKey});
  if(!plain(snapshot)||snapshot.story_key!==job.storyKey||!sha(snapshot.evidence_hash)||!Array.isArray(snapshot.evidence)||snapshot.evidence.length<1||snapshot.evidence.length>20)throw Error();
  const evidence=snapshot.evidence.map(e=>{if(!plain(e))throw Error();return project(e,['id','url','text','sourceType','visibility','sourceLinks','nativeUri','nativeUrl','nativeCid','nativeAuthorDid']);});
  const history=await readHistory(rpc,started),sources=[];let remainingBytes=approved.provider==='Cerebras'?100000:200000; // Full captures or deferral, never truncation; Cerebras retains the pilot capacity mitigation.
  for(const item of evidence){
   if(Date.now()-started>30000||remainingBytes<1)throw Error();
   if(item.sourceType==='bluesky'){
    const fetched=await fetchNativeEvidence({evidence:item,fetcher:evidenceFetcher,maxBytes:remainingBytes,timeoutMs:Math.min(config.sourceTimeoutMs??10000,10000),now});
    remainingBytes-=encoder.encode(fetched.body).length;sources.push({...fetched});continue;
   }
   const url=[item.url,...(item.sourceLinks??[])].find(raw=>{try{const u=new URL(raw);return isApprovedPrimarySourceUrl(raw)&&config.allowedSourceHosts.includes(u.hostname)&&u.protocol==='https:'&&u.href===raw&&!u.username&&!u.password&&!u.port&&!u.hash;}catch{return false;}});
   if(!url||!isApprovedPrimarySourceUrl(url))return finishDeferred('unapproved_primary_source');
   if(new URL(url).hostname==='github.com'&&/\/releases\/tag\//.test(new URL(url).pathname)){const fetched=await fetchGithubReleaseEvidence({url,evidence:item,fetcher:evidenceFetcher,maxBytes:Math.min(remainingBytes,100000),timeoutMs:Math.min(config.sourceTimeoutMs??10000,10000),now});remainingBytes-=encoder.encode(fetched.body).length;sources.push({...fetched});continue;}
   const fetched=await fetchCapturedEvidence({url,evidence:item,config:{enabled:true,allowedHosts:config.allowedSourceHosts,maxBytes:remainingBytes,timeoutMs:Math.min(config.sourceTimeoutMs??10000,10000)},fetcher:evidenceFetcher});
   if(!text(fetched.body)||!sha(fetched.contentSha256))throw Error();remainingBytes-=fetched.byteLength;
   sources.push(project(fetched,['evidenceId','url','contentSha256','fetchedAt','body']));
  }
  if(Date.now()-started>40000)throw Error();
  input={storyKey:job.storyKey,evidenceHash:snapshot.evidence_hash,evidence,sources,history,now:now()};
  request=buildVerificationRequest(input,{model:config.model,maxOutputTokens:config.maxOutputTokens});
  requestSha256=await hash(JSON.stringify({...request,stream:false}));
 }catch{return finishDeferred('evidence_or_history_unavailable');}
 let reservation;
 try{
  reservation=await rpc('warpcore_verification_reserve',{...ids,p_hash:requestSha256,p_max:approved.maxCostCredits,p_metadata:{model:approved.model,profileVersion:VERIFICATION_REQUEST_PROFILE_VERSION,expectedProvider:approved.provider}});
  if(!uuid(reservation))throw Error();
 }catch{return {status:'uncertain',reason:'reservation_unconfirmed',...flags};}
 try{if(await rpc('warpcore_verification_dispatch',ids)!==true)throw Error();}
 catch{return {status:'uncertain',reason:'dispatch_unconfirmed',...flags};}
 let result;
 try{result=await verifyWithOpenRouter(request,{...config,reservation:{id:reservation,maxCostCredits:approved.maxCostCredits}},modelFetcher);}
 catch(error){
  const billed=error instanceof OpenRouterAttemptError&&validUsage(error?.usage)&&billedCodes.has(error.code);
  const diagnostic=attemptDiagnostic(error,config.apiKey),usage=billed?project(error.usage,['promptTokens','completionTokens','totalTokens','costCredits']):undefined;
  const identity=diagnostic&&auditIdentity(diagnostic)?project(diagnostic,['generationId','model','provider']):undefined;
  const audit={...(billed?(identity?{...identity,usage,validationError:error.code}:{usage,errorCode:error.code}):{errorCode:unknownCodes.has(error?.code)?error.code:'unknown_failure'}),...(diagnostic?{diagnostic}:{})};
  try{if(await rpc('warpcore_verification_settle',{...ids,p_status:billed?'settled':'uncertain',p_cost:billed?error.usage.costCredits:null,p_audit:audit})!==true)throw Error();}
  catch{return {status:'uncertain',reason:'settlement_unconfirmed',...flags};}
  return billed?finishDeferred('billed_invalid_completion'):{status:'uncertain',reason:'paid_outcome_unknown',...flags};
 }
 // Settle known usage before semantic validation or any receipt/inbox mutation.
 const archivedResult=boundedVerificationAuditResult(result.result,config.apiKey);
 try{if(await rpc('warpcore_verification_settle',{...ids,p_status:'settled',p_cost:result.usage.costCredits,p_audit:{model:result.model,provider:result.provider,generationId:result.generationId,usage:result.usage,...(archivedResult===undefined?{}:{result:archivedResult})}})!==true)throw Error();}
 catch{return {status:'uncertain',reason:'settlement_unconfirmed',...flags};}
 let validated;
 try{validated=await validateVerificationResult(result.result,input);}catch(error){return finishDeferred(error instanceof VerificationValidationError&&VERIFICATION_PUBLIC_REASONS.includes(error.code)?error.code:'unsupported_verification');}
 if(validated.action==='defer')return finishDeferred('model_deferred');
 // Pure, non-sending preflight applies the same attribution/text guards as curation.
 try{const packet=await createReviewPacket({storyKey:input.storyKey,evidence:input.evidence,editorial:validated.editorial});const draft=await approveReview(packet,{factsVerified:true,meaningfulChange:true,scopeApproved:true,contentHash:packet.contentHash});if(draft.mode!=='repost')await previewRecord(draft,input.now);}catch{return finishDeferred('verification_post_unpublishable');}
 const material={version:'agent-verification-v1',agentId:AGENT,runId:job.rankingRunId,storyKey:job.storyKey,evidenceHash:input.evidenceHash,
 editorial:{...validated.editorial,verification:{checkedAt:input.now,sourceUrls:input.sources.filter(s=>validated.editorial.evidenceIds.includes(s.evidenceId)).map(s=>s.url),reason:'Model-supported primary-evidence judgment with validated exact quote bindings.'}},
 model:approved.model,policyVersion:POLICY_VERSION,requestProfileVersion:VERIFICATION_REQUEST_PROFILE_VERSION,requestSha256,judgment:validated.judgment,sources:input.sources};
 let receipt;
 try{receipt=await rpc('warpcore_agent_issue_receipt',{p_material:material});if(!uuid(receipt))throw Error();}
 catch{return {status:'uncertain',reason:'receipt_unconfirmed',...flags};}
 try{if(await rpc('warpcore_verification_finish',{...ids,p_status:'verified',p_receipt:receipt})!==true)throw Error();}
 catch{return {status:'uncertain',reason:'finish_unconfirmed',...flags};}
 return handoff(receipt);
}
