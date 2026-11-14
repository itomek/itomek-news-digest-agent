import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const {buildReviewRequest}=await import(pathToFileURL(root+'/supabase/functions/news-agent/evaluation.mjs'));
const {serializeReviewBody}=await import(pathToFileURL(root+'/supabase/functions/news-agent/openrouter.mjs'));
const cases=JSON.parse(await fs.readFile(root+'/supabase/functions/news-agent/real-story-cases.json','utf8'));
const cfg={model:'measurement/placeholder',allowedModels:['measurement/placeholder'],maxOutputTokens:2048};
const bytes=s=>Buffer.byteLength(s,'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
function measure(name,input){
 const request=buildReviewRequest(input,cfg);
 const raw=JSON.stringify({...request,stream:false,provider:{allow_fallbacks:false,require_parameters:true}});
 let transportAccepted=true;try{serializeReviewBody(request);}catch{transportAccepted=false;}
 return {name,candidates:input.length,requestBytes:bytes(raw),systemContentBytes:bytes(request.messages[0].content),userContentBytes:bytes(request.messages[1].content),combinedMessageContentBytes:request.messages.reduce((n,m)=>n+bytes(m.content),0),requestSha256:hash(raw),transportAccepted,containsGoldFields:/expectedAction|ownerRationale|Negative expectation/.test(raw)};
}
const short405=Array.from({length:405},(_,i)=>({...cases[0],id:String(i)}));
const stamp='2026-11-14T20:00:00Z';
const large405=Array.from({length:405},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),sourceUrl:`https://example.com/${i+1}`,sourceType:'rss',sourceCreatedAt:stamp,discoveryText:`Synthetic candidate ${i+1}: `+'x'.repeat(6000)}));
function pack(input,maxCount=100){
 const batches=[];let index=0;
 while(index<input.length){
  let size=Math.min(maxCount,input.length-index);
  while(size>0){try{serializeReviewBody(buildReviewRequest(input.slice(index,index+size),cfg));break;}catch(error){if(error.code!=='request_too_large')throw error;size--;}}
  if(size===0)throw Error('Oversized single candidate');
  batches.push(measure(`batch-${batches.length+1}`,input.slice(index,index+size)));index+=size;
 }
 return {maxCandidatesPerInvocation:maxCount,requests:batches.length,totalRequestBytes:batches.reduce((sum,b)=>sum+b.requestBytes,0),batchSizes:batches.map(b=>b.candidates),requestBytes:batches.map(b=>b.requestBytes)};
}
const output={environment:{node:process.version,measuredAt:new Date().toISOString(),modelPlaceholder:cfg.model,outputTokenCap:cfg.maxOutputTokens,requestByteCap:200000,notes:'No tokenizer, network, credentials or model calls; serialized byte counts depend on chosen model ID and output cap.'},measurements:[measure('eight-recorded-public-discovery-cases',cases),measure('405-same-source-copy-fixture-from-evaluation-test',short405),measure('405-large-same-source-fixture-from-paged-runtime-integration',large405)],packed:{short405:pack(short405),large405:pack(large405)},corpus:{cases:cases.length,expectedVerify:cases.filter(c=>c.expectedAction==='verify').length,expectedSkip:cases.filter(c=>c.expectedAction==='skip').length,ownerLabeled:1,provisional:7,heldoutFrozen:false}};

console.log(JSON.stringify(output,null,2));
