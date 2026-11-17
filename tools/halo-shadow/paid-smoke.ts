// One CLI invocation of the shared SQL-backed runtime. No server or scheduler.
import {createAgentService} from '../../supabase/functions/news-agent/services.mjs';
import {requestProfileForModel,expectedProviderForModel} from '../../supabase/functions/news-agent/model-profiles.mjs';
import {approvedRuntimeModel} from '../../supabase/functions/news-agent/approved-runtime-models.mjs';
const ORIGIN='https://haloshadowlocal00001.supabase.co';
const ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const operations=new Set(['claim','load','paged_bind_config','paged_preview','paged_begin','paged_reserve','dispatch','paged_settle','paged_commit','paged_uncertain']);
export async function runPaidSmoke(env:Record<string,string|undefined>,fetcher:typeof fetch=fetch){
 const runId=env.HALO_PAID_RUN_ID,model=env.HALO_PAID_MODEL,hash=env.HALO_PAID_REQUEST_HASH;
 const serviceKey=env.HALO_PAID_SERVICE_JWT,apiKey=env.OPENROUTER_API_KEY,reservationUsd=Number(env.HALO_PAID_RESERVATION_USD);
 const approved=approvedRuntimeModel(model),profile=requestProfileForModel(model,approved?.discoveryProfileVersion),expectedProvider=expectedProviderForModel(model,profile?.version),maxOutputTokens=approved?.maxOutputTokens??2048,reviewBatchSize=approved?.reviewBatchSize??4;
 if(approved&&reservationUsd!==approved.maxCostCredits)throw Error('Reviewed smoke reservation required');
 if(!uuid.test(runId??'')||!uuid.test(env.HALO_PAID_LEDGER_ATTEMPT_ID??'')||!/^[a-f0-9]{64}$/.test(hash??'')||profile?.provider.zdr!==true||!expectedProvider||!Number.isFinite(reservationUsd)||reservationUsd<=0||reservationUsd>2||!serviceKey||!apiKey||/[\r\n]/.test(serviceKey+apiKey))throw Error('Invalid approved smoke plan');
 let posts=0;
 const transport:typeof fetch=async(raw,options={})=>{
  const url=new URL(String(raw)),headers=new Headers(options.headers);
  if(url.href===ENDPOINT){
   if(posts!==0||options.method!=='POST'||options.redirect!=='error'||typeof options.body!=='string')throw Error('Paid smoke dispatch refused');
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(options.body));
   const actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
   const body=JSON.parse(options.body);
   if(actual!==hash||body.model!==model||body.max_tokens!==maxOutputTokens||body.provider?.zdr!==true||headers.get('authorization')!==`Bearer ${apiKey}`)throw Error('Paid smoke request differs from approved bytes');
   posts++;
   return fetcher(ENDPOINT,options);
  }
  const operation=url.pathname.startsWith('/rest/v1/rpc/warpcore_shadow_')?url.pathname.slice('/rest/v1/rpc/warpcore_shadow_'.length):'';
  if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!operations.has(operation)||options.method!=='POST'||options.redirect!=='error'||headers.get('authorization')!==`Bearer ${serviceKey}`||headers.get('apikey')!==serviceKey)throw Error('Paid smoke database destination refused');
  return fetcher(new URL(url.pathname.slice('/rest/v1'.length),'http://postgrest:3000'),options);
 };
 const service=createAgentService({projectUrl:ORIGIN,serviceKey,runtimeConfig:{enabled:true,requireModelProfile:true,model,allowedModels:[model],apiKey,maxOutputTokens,maxCostCredits:reservationUsd,timeoutMs:30000,maxResponseBytes:200000,leaseSeconds:120},invocationOptions:{pageSteps:1,reviewBatchSize}},transport);
 const result=await service.runInvocation(runId);
 const state='state' in result?result.state:undefined;
 return {status:result.status,runId,model,expectedProvider,modelPosts:posts,phase:state?.phase,candidateCount:state?.candidateCount,reviewedCount:state?.reviewedCount,publishingEnabled:false,modelQualityProven:false};
}
if(import.meta.main){
 try{
  const names=['HALO_PAID_RUN_ID','HALO_PAID_MODEL','HALO_PAID_REQUEST_HASH','HALO_PAID_RESERVATION_USD','HALO_PAID_SERVICE_JWT','HALO_PAID_LEDGER_ATTEMPT_ID','OPENROUTER_API_KEY'];
  const env=Object.fromEntries(names.map(name=>[name,Deno.env.get(name)]));
  console.log(JSON.stringify(await runPaidSmoke(env)));
 }catch{console.error(JSON.stringify({status:'paid_smoke_stopped_inspect_sql_no_retry',publishingEnabled:false}));Deno.exitCode=1;}
}
