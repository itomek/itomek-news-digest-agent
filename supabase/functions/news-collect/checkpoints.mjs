import {candidateRow} from '../bluesky-collect/store.mjs';
import {runAdapters} from '../_shared/pipeline.mjs';

const DAY=86400000;
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
 return value;
}
export async function configurationHash(selection){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable({adapter:selection.adapter,config:selection.config??{}}))));
 return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function createCheckpointStore(env,fetcher=fetch){
 const url=new URL(env.SUPABASE_URL);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password)throw Error('Invalid project');
 const rpc=async(name,body)=>{
  const target=new URL(url);target.pathname=`/rest/v1/rpc/${name}`;target.search='';target.hash='';
  const response=await fetcher(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw Error('Checkpoint persistence failed');
  return response.json();
 };
 return {begin:args=>rpc('warpcore_sync_begin',args),finish:args=>rpc('warpcore_sync_finish',args)};
}

// No candidate writes occur outside finish: ingestion and checkpoint movement are
// one database transaction, fenced by the per-source lease token.
export async function syncSource(selection,registry,store,upper){
 let lease;
 const id=/^[a-z0-9_-]{1,64}$/i.test(selection?.id??'')?selection.id:'invalid';
 const sourceKey=`${selection?.adapter}:${id}`;
 try{
  if(id==='invalid'||!/^[a-z0-9_-]{1,32}$/i.test(selection.adapter))throw Error('Invalid source');
  const adapter=Object.hasOwn(registry,selection.adapter)&&registry[selection.adapter];
  if(!adapter||typeof adapter.collectPage!=='function')throw Error('Checkpoint adapter unavailable');
  lease=await store.begin({p_source_key:sourceKey,p_source_type:selection.adapter,p_source_id:id,p_config_hash:await configurationHash(selection),p_bootstrap_since:new Date(Date.parse(upper)-7*DAY).toISOString(),p_upper:upper});
  if(!lease.acquired)return {id,status:'busy',count:0,incomplete_catch_up:true,last_successful_sync:lease.last_success_at??null,covered_through:lease.covered_through??null,lag_seconds:lease.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(lease.covered_through))/1000)):null};
  const page=await adapter.collectPage(selection.config??{},{since:lease.window_since,until:lease.window_until,cursor:lease.cursor??null});
  if(!page||!Array.isArray(page.items)||page.items.length>5000||typeof page.complete!=='boolean'||typeof page.coverageGap!=='boolean')throw Error('Invalid page');
  if(!page.complete&&(page.cursor===null||page.cursor===undefined))throw Error('Missing continuation');
  if(page.earliestAvailableAt!=null&&!Number.isFinite(Date.parse(page.earliestAvailableAt)))throw Error('Invalid earliest coverage');
  if(!Number.isInteger(page.fetchedCount)||page.fetchedCount<page.items.length||page.fetchedCount>10000)throw Error('Invalid fetched count');
  // Finite feeds may retain thousands of items within the adapter's 1 MB
  // response bound. Reuse the existing 500-item validation batches without
  // splitting persistence: all validated evidence and state commit together.
  const validated=[];
  for(let offset=0;offset<page.items.length;offset+=500){
   const normalized=await runAdapters([selection],{[selection.adapter]:{collect:async()=>page.items.slice(offset,offset+500)}});
   if(normalized.sources[0].status!=='ok')throw Error('Invalid candidates');
   validated.push(...normalized.candidates);
  }
  // The upper bound is fixed across resumed invocations; late newer items will
  // be collected in the next window, with a 24-hour overlap on successful runs.
  const candidates=validated.filter(item=>Date.parse(item.created_at)<=Date.parse(lease.window_until));
  const items=await Promise.all(candidates.map(candidateRow));
  const outcome=!page.complete?'partial':page.coverageGap?'gap':page.fetchedCount?'complete':'empty';
  const result=await store.finish({p_source_key:sourceKey,p_token:lease.token,p_items:items,p_outcome:outcome,p_cursor:page.complete?null:page.cursor,p_earliest_available:page.earliestAvailableAt??null,p_error_code:page.coverageGap?'upstream_history_unproven':null,p_fetched:page.fetchedCount});
  if(!result.accepted)throw Error('Lease rejected');
  const status=result.status??outcome;
  return {id,status,count:items.length,fetched:result.fetched??page.fetchedCount,new:result.new??0,duplicate:result.duplicate??0,last_successful_sync:result.last_success_at??null,covered_through:result.covered_through??null,lag_seconds:result.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(result.covered_through))/1000)):null,incomplete_catch_up:['partial','gap','failed','running','busy'].includes(status),coverage_gap:status==='gap'||page.coverageGap,earliest_available:page.earliestAvailableAt??null};
 }catch(error){
  const code=/^source_(?:http_[1-5][0-9]{2}|content_type|timeout|network|body_limit|parse_failed)$/.test(error?.code??'')?error.code:'source_or_persistence_failed';
  if(lease?.acquired){try{await store.finish({p_source_key:sourceKey,p_token:lease.token,p_items:[],p_outcome:'failed',p_cursor:lease.cursor??null,p_earliest_available:null,p_error_code:code,p_fetched:0});}catch{/* Preserve the lease for crash-safe expiry and retry. */}}
  return {id,status:'failed',count:0,error:code,incomplete_catch_up:true,last_successful_sync:lease?.last_success_at??null,covered_through:lease?.covered_through??null,lag_seconds:lease?.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(lease.covered_through))/1000)):null};
 }
}
export async function syncSources(selections,registry,store,upper=new Date().toISOString()){
 const sources=new Array(selections.length);let cursor=0;
 const worker=async()=>{while(cursor<selections.length){const index=cursor++;sources[index]=await syncSource(selections[index],registry,store,upper);}};
 await Promise.all(Array.from({length:Math.min(5,selections.length)},worker));
 return {sources,candidates_submitted:sources.reduce((sum,source)=>sum+source.count,0)};
}
