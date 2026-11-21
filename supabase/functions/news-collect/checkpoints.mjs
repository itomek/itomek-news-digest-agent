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
 return {begin:args=>rpc('warpcore_sync_begin',args),finish:args=>rpc('warpcore_sync_finish',args),collected:()=>rpc('warpcore_collection_finished',{})};
}

// No candidate writes occur outside finish: ingestion and checkpoint movement are
// one database transaction, fenced by the per-source lease token.
export async function syncSource(selection,registry,store,upper){
 let lease,configGeneration;
 const id=/^[a-z0-9_-]{1,64}$/i.test(selection?.id??'')?selection.id:'invalid';
 const sourceKey=`${selection?.adapter}:${id}`;
 try{
  if(id==='invalid'||!/^[a-z0-9_-]{1,32}$/i.test(selection.adapter))throw Error('Invalid source');
  configGeneration=await configurationHash(selection);
  const adapter=Object.hasOwn(registry,selection.adapter)&&registry[selection.adapter];
  if(!adapter||typeof adapter.collectPage!=='function')throw Error('Checkpoint adapter unavailable');
  lease=await store.begin({p_source_key:sourceKey,p_source_type:selection.adapter,p_source_id:id,p_config_hash:configGeneration,p_bootstrap_since:new Date(Date.parse(upper)-7*DAY).toISOString(),p_upper:upper});
  if(!lease.acquired)return {id,source_key:sourceKey,status:'busy',config_generation:configGeneration??null,source_generation:lease?.generation??null,head_check_succeeded:false,count:0,incomplete_catch_up:true,last_successful_sync:lease.last_success_at??null,covered_through:lease.covered_through??null,lag_seconds:lease.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(lease.covered_through))/1000)):null};
  const windows=[{since:lease.window_since,until:lease.window_until,cursor:lease.cursor??null}];
  // Refresh the head during long historical scans so current news does not wait
  // for archive exhaustion. Only the original backlog page controls coverage.
  if(['bluesky','huggingface_posts','hn'].includes(selection.adapter)&&lease.cursor!=null)windows.push({since:lease.window_since,until:upper,cursor:null});
  const fetchedPages=await Promise.allSettled(windows.map(window=>adapter.collectPage(selection.config??{},window)));
  const rejected=fetchedPages.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
  const pages=fetchedPages.map(result=>result.value),page=pages[0],candidates=[];
  let fetchedCount=0,coverageGap=false,earliestAvailableAt=null;const coverageReasons=new Set();
  for(let index=0;index<pages.length;index++){
   const current=pages[index];
   if(!current||!Array.isArray(current.items)||current.items.length>5000||typeof current.complete!=='boolean'||typeof current.coverageGap!=='boolean')throw Error('Invalid page');
   if(!current.complete&&(current.cursor===null||current.cursor===undefined))throw Error('Missing continuation');
   if(current.earliestAvailableAt!=null&&!Number.isFinite(Date.parse(current.earliestAvailableAt)))throw Error('Invalid earliest coverage');
   if(!Number.isInteger(current.fetchedCount)||current.fetchedCount<current.items.length||current.fetchedCount>10000)throw Error('Invalid fetched count');
   if(current.coverageGap&&['finite_feed_history','finite_index_history','finite_top_story_snapshot','malformed_source_dates'].includes(current.gapReason))coverageReasons.add(current.gapReason);
   fetchedCount+=current.fetchedCount;coverageGap ||= current.coverageGap;
   if(current.earliestAvailableAt!=null&&(earliestAvailableAt===null||Date.parse(current.earliestAvailableAt)<Date.parse(earliestAvailableAt)))earliestAvailableAt=current.earliestAvailableAt;
   // Retain the existing 500-item evidence validation and 5000-item transaction
   // bound. Every page validates fully before any candidate write occurs.
   for(let offset=0;offset<current.items.length;offset+=500){
    const normalized=await runAdapters([selection],{[selection.adapter]:{collect:async()=>current.items.slice(offset,offset+500)}});
    if(normalized.sources[0].status!=='ok')throw Error('Invalid candidates');
    candidates.push(...normalized.candidates.filter(item=>Date.parse(item.created_at)<=Date.parse(windows[index].until)));
   }
  }
  const unique=[...new Map(candidates.map(candidate=>[candidate.uri,candidate])).values()];
  if(unique.length>5000||fetchedCount>10000)throw Error('Combined page exceeds persistence bounds');
  const items=await Promise.all(unique.map(candidateRow));
  const outcome=!page.complete?'partial':coverageGap?'gap':fetchedCount?'complete':'empty';
  const headCheckedAt=lease.cursor==null?lease.window_until:(windows.length>1?upper:null);
  const result=await store.finish({p_head_checked_at:headCheckedAt??lease.head_checked_at??null,p_coverage_reasons:[...coverageReasons],p_source_key:sourceKey,p_token:lease.token,p_items:items,p_outcome:outcome,p_cursor:page.complete?null:page.cursor,p_earliest_available:earliestAvailableAt,p_error_code:coverageGap?'upstream_history_unproven':null,p_fetched:fetchedCount});
  if(!result.accepted)throw Error('Lease rejected');
  const status=result.status??outcome;
  return {id,source_key:sourceKey,status,config_generation:configGeneration??null,source_generation:lease?.generation??null,head_check_succeeded:headCheckedAt!=null&&Date.parse(headCheckedAt)===Date.parse(upper),head_checked_at:headCheckedAt??lease.head_checked_at??null,...(coverageReasons.size?{coverage_reasons:[...coverageReasons]}:{}),count:items.length,fetched:result.fetched??fetchedCount,new:result.new??0,duplicate:result.duplicate??0,last_successful_sync:result.last_success_at??null,covered_through:result.covered_through??null,lag_seconds:result.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(result.covered_through))/1000)):null,incomplete_catch_up:['partial','gap','failed','running','busy'].includes(status),coverage_gap:status==='gap'||coverageGap,earliest_available:earliestAvailableAt};
 }catch(error){
  const code=/^source_(?:http_[1-5][0-9]{2}|content_type|timeout|network|body_limit|parse_failed)$/.test(error?.code??'')?error.code:'source_or_persistence_failed';
  if(lease?.acquired){try{await store.finish({p_source_key:sourceKey,p_token:lease.token,p_items:[],p_outcome:'failed',p_cursor:lease.cursor??null,p_earliest_available:null,p_error_code:code,p_fetched:0});}catch{/* Preserve the lease for crash-safe expiry and retry. */}}
  return {id,source_key:sourceKey,status:'failed',config_generation:configGeneration??null,source_generation:lease?.generation??null,head_check_succeeded:false,count:0,error:code,incomplete_catch_up:true,last_successful_sync:lease?.last_success_at??null,covered_through:lease?.covered_through??null,lag_seconds:lease?.covered_through?Math.max(0,Math.floor((Date.parse(upper)-Date.parse(lease.covered_through))/1000)):null};
 }
}
export async function syncSources(selections,registry,store,upper=new Date().toISOString()){
 const sources=new Array(selections.length);let cursor=0;
 const worker=async()=>{while(cursor<selections.length){const index=cursor++;sources[index]=await syncSource(selections[index],registry,store,upper);}};
 await Promise.all(Array.from({length:Math.min(5,selections.length)},worker));
 return {sources,candidates_submitted:sources.reduce((sum,source)=>sum+source.count,0)};
}
