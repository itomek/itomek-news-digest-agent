// Public HN discovery only. Engagement is a snapshot, not measured acceleration.
// This module does not activate sources, fetch external article URLs, or publish.
const API='https://hacker-news.firebaseio.com/v0';
async function readJSON(path,fetcher){
 const response=await fetcher(`${API}/${path}`,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
 if(!response.ok||response.redirected)throw new Error('HN HTTP failure');
 if(Number(response.headers.get('content-length'))>1000000)throw new Error('HN body limit');
 const reader=response.body?.getReader();if(!reader)throw new Error('HN empty body');
 let bytes=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1000000)throw new Error('HN body limit');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(buffer));
}
export async function collectHN(config={},fetcher=fetch,now=Date.now()){
 const {terms,minScore=100,minComments=30,maxItems=20,maxAgeHours=48}=config;
 if(!Array.isArray(terms)||terms.length<1||terms.length>30||terms.some(t=>typeof t!=='string'||!t.trim()||t.length>80)||
 !Number.isSafeInteger(minScore)||minScore<0||!Number.isSafeInteger(minComments)||minComments<0||
 !Number.isInteger(maxItems)||maxItems<1||maxItems>20||!Number.isFinite(maxAgeHours)||maxAgeHours<=0||maxAgeHours>48||!Number.isFinite(now))throw new Error('Invalid HN config');
 const ids=await readJSON('topstories.json',fetcher);
 if(!Array.isArray(ids)||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid HN top IDs');
 const rows=[];const lowered=terms.map(t=>t.trim().toLowerCase());
 // Seven batches of at most three plus index: <=40 seconds of request time.
 const selected=[...new Set(ids.slice(0,maxItems))];
 for(let start=0;start<selected.length;start+=3){
  const batch=selected.slice(start,start+3);
  // allSettled drains each batch before reporting errors; no orphan requests.
  const results=await Promise.allSettled(batch.map(id=>readJSON(`item/${id}.json`,fetcher)));
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
  for(let index=0;index<batch.length;index++){
  const id=batch[index],item=results[index].value;
  if(!item||item.id!==id||item.type!=='story'||item.deleted||item.dead||typeof item.title!=='string'||!item.title.trim()||
   !Number.isFinite(item.time)||item.time*1000>now||now-item.time*1000>maxAgeHours*3600000||
   !Number.isFinite(item.score)||item.score<minScore||!Number.isFinite(item.descendants)||item.descendants<minComments||
   !lowered.some(term=>item.title.toLowerCase().includes(term)))continue;
  const discussion=`https://news.ycombinator.com/item?id=${id}`;
  let url=discussion;
  try{const parsed=new URL(item.url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)url=parsed.href;}catch{/* Self posts use HN discussion. */}
  rows.push({id:`hn:${id}`,text:item.title,author:'Hacker News community',publishedAt:new Date(item.time*1000).toISOString(),visibility:'public',url,discussion_url:discussion,
   signal:'community_snapshot',status:'unverified_review_required',score:item.score,comments:item.descendants,observedAt:new Date(now).toISOString()});
  }
 }
 return rows;
}
