// Explicit one-shot canary. Default is metadata-only; never buys credits or retries.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {buildReviewRequest} from '../../supabase/functions/news-agent/evaluation.mjs';
import {serializeReviewBody} from '../../supabase/functions/news-agent/openrouter.mjs';
import {requestProfileForModel} from '../../supabase/functions/news-agent/model-profiles.mjs';
import {reservationEnvelope,fundingReady,campaignBlockReason,requireZdrEndpoint} from './preflight.mjs';
import {openPilotLedger} from './ledger.mjs';
import {executeCanary} from './canary.mjs';
import {selectDevelopmentBatch} from './batches.mjs';
const allowedModels=['google/gemma-4-31b-it','google/gemma-4-26b-a4b-it'];
const MODEL=process.argv[3]??allowedModels[0];
const batch=process.argv[4]??'all';
const mode=process.argv[2]??'--preflight';
const stateDir=path.join(os.homedir(),'.local/state/warpcore/openrouter-pilot-20261115');
let ledger;
const stop=code=>{const e=new Error(code);e.pilotCode=code;throw e;};
async function jsonGet(url,key,maxBytes=1000000){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:key?{Authorization:'Bearer '+key}:{}});
 if(!response.ok||!response.body)stop('metadata_request_failed');
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)stop('metadata_too_large');parts.push(value);}}finally{void reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function loadKey(){
 const file=path.join(os.homedir(),'.config/warpcore/openrouter-pilot.env');
 const st=await fs.lstat(file);if(!st.isFile()||(st.mode&0o077)!==0)stop('private_key_file_permissions');
 const lines=(await fs.readFile(file,'utf8')).split(/\r?\n/).map(line=>line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/)).filter(Boolean);
 if(lines.length!==1)stop('one_pilot_key_required');
 let key=lines[0][1];if((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'")))key=key.slice(1,-1);
 if(!/^[A-Za-z0-9_-]{20,4096}$/.test(key))stop('invalid_pilot_key');return key;
}
async function save(name,data){await fs.writeFile(path.join(stateDir,name),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});}
try{
 if(!['--preflight','--canary'].includes(mode))stop('use_preflight_or_canary');
 if(!allowedModels.includes(MODEL)||process.argv.length>5||!['all','first-half','second-half','helion-scope'].includes(batch))stop('unsupported_pilot_model_or_arguments');
 const key=await loadKey();
 ledger=openPilotLedger(path.join(stateDir,'campaign.sqlite3'));
 const keyData=(await jsonGet('https://openrouter.ai/api/v1/key',key)).data;
 const credits=(await jsonGet('https://openrouter.ai/api/v1/credits',key)).data;
 const metadata=(await jsonGet(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`)).data;
 const profile=requestProfileForModel(MODEL);
 const endpoint=metadata?.endpoints?.find(e=>e.tag===profile.provider.only[0]&&!e.service_tier);
 const zdrRows=(await jsonGet('https://openrouter.ai/api/v1/endpoints/zdr',undefined,2000000)).data;
 requireZdrEndpoint(endpoint,MODEL,zdrRows);
 const envelope=reservationEnvelope(endpoint,MODEL);
 const cases=selectDevelopmentBatch(JSON.parse(await fs.readFile(new URL('../../supabase/functions/news-agent/real-story-cases.json',import.meta.url),'utf8')).map((c,i)=>({...c,id:createHash('sha256').update('canary-case-'+i).digest('hex')})),batch);
 const request=buildReviewRequest(cases,{model:MODEL,allowedModels:[MODEL],maxOutputTokens:2048,requestProfile:profile});
 const body=serializeReviewBody(request),requestHash=createHash('sha256').update(body).digest('hex');
 const funded=fundingReady(keyData,credits,envelope.reservationUsd);
 const campaign=ledger.snapshot();
 const reason=campaignBlockReason(campaign,{requestHash,reservationUsd:envelope.reservationUsd})??(funded?null:'funding_or_key_scope_not_verified');
 const ready=reason===null;
 const preflight={at:new Date().toISOString(),status:ready?'ready':'blocked',reason,mode,model:MODEL,batch,profile,envelope,requestHash,requestBytes:Buffer.byteLength(body),cases:cases.length,developmentLabelsOnly:true,creditPurchasePerformed:false,paidCallsMade:0,campaign};
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 await save(`preflight-${stamp}.json`,preflight);
 console.log(JSON.stringify({status:preflight.status,reason:preflight.reason,model:MODEL,reservationUsd:envelope.reservationUsd,requestBytes:preflight.requestBytes,approvedCampaignUsd:2,maximumCalls:24,paidCallsMade:0}));
 if(mode==='--preflight'||!ready){if(!ready)process.exitCode=2;}
 else{
  // Every allowed dispatch is durably counted and reserved before HTTP.
  const attempt=ledger.reserve({requestHash,model:MODEL,reservationUsd:envelope.reservationUsd});
  const report=await executeCanary({request,model:MODEL,apiKey:key,expectedProvider:envelope.expectedProvider,maxCostCredits:envelope.reservationUsd,ledger,attempt,cases,save});
  console.log(JSON.stringify({status:report.status,provider:report.provider,model:report.model,reviewed:report.decisions.length,costUsd:report.usage.costCredits,elapsedMs:report.elapsedMs,modelQualityProven:false}));
 }
}catch(error){console.error(JSON.stringify({status:'stopped',code:error?.pilotCode??'preflight_or_ledger_failed'}));process.exitCode=1;}
finally{ledger?.close();}
