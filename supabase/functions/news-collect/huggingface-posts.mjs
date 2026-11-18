// Anonymous community discovery. Offset pagination is mutable upstream: retain
// the finite-history gap even on exhaustion; never claim exhaustive coverage.
const ORIGIN='https://huggingface.co';
const fail=code=>{throw Object.assign(Error(code),{code});};
function publicLink(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/^\d|localhost|\.local$/.test(u.hostname)&&!u.hostname.startsWith('[')?u.href:null;}catch{return null;}}
export async function collectHuggingFacePostsPage(config={},fetcher=fetch,window={}){
 const since=Date.parse(window.since),until=Date.parse(window.until),cursor=window.cursor;
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length||!Number.isFinite(since)||!Number.isFinite(until)||since>until)throw Error('Invalid HF configuration/window');
 if(cursor!=null&&(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='last,skip'||!Number.isSafeInteger(cursor.skip)||cursor.skip<1||cursor.skip>1000000||typeof cursor.last!=='string'||!/^https:\/\/huggingface[.]co\/posts\/[a-zA-Z0-9_-]{1,96}\/\d{1,32}$/.test(cursor.last)))throw Error('Invalid HF continuation');
 let response;
 try{response=await fetcher(`${ORIGIN}/api/posts?skip=${cursor?.skip??0}&sort=recent`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json','User-Agent':'WarpCorePublicNews/1.0'}});}
 catch(error){fail(['AbortError','TimeoutError'].includes(error?.name)?'source_timeout':'source_network');}
 if(!response.ok)fail(`source_http_${response.status}`);
 if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))fail('source_content_type');
 const reader=response.body?.getReader();if(!reader)fail('source_network');
 const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)fail('source_body_limit');chunks.push(value);}}
 catch(error){if(error?.code)throw error;fail(['AbortError','TimeoutError'].includes(error?.name)?'source_timeout':'source_network');}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{
  const data=JSON.parse(new TextDecoder().decode(bytes)),posts=data?.socialPosts;
  if(!Array.isArray(posts)||posts.length>100)throw Error();
  const items=[],seen=new Set();let oldest=Infinity,previous=Infinity,last=null;
  for(const p of posts){
   if(!p||typeof p.slug!=='string'||!/^\d{1,32}$/.test(p.slug)||typeof p.author?.name!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(p.author.name)||p.url!==`/posts/${p.author.name}/${p.slug}`||typeof p.rawContent!=='string'||!p.rawContent.trim()||p.rawContent.length>18000||!Array.isArray(p.content)||typeof p.publishedAt!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(p.publishedAt))throw Error();
   const date=Date.parse(p.publishedAt),url=ORIGIN+p.url;
   if(!Number.isFinite(date)||date>previous||seen.has(url))throw Error();
   previous=date;oldest=Math.min(oldest,date);last=url;seen.add(url);
   if(date<since||date>until)continue;
   // Preserve the originating author/post alongside an outbound discovery link.
   // Neither is verified here; the worker applies its exact provenance policy
   // and captured-source checks before any claim can support publication.
   const outbound=p.content.map(c=>publicLink(c?.href??c?.url)).find(Boolean);
   items.push({id:url,url:outbound??url,nativeUrl:url,text:p.rawContent,author:p.author.name,publishedAt:new Date(date).toISOString(),visibility:'public'});
  }
  if(posts.length&&last===cursor?.last)throw Error();
  const complete=!posts.length||oldest<since;
  return {items,complete,cursor:complete?null:{skip:(cursor?.skip??0)+posts.length,last},earliestAvailableAt:posts.length?new Date(oldest).toISOString():null,coverageGap:true,gapReason:'finite_feed_history',fetchedCount:posts.length};
 }catch{fail('source_parse_failed');}
}
export async function collectHuggingFacePosts(config={},fetcher=fetch,now=Date.now()){
 return (await collectHuggingFacePostsPage(config,fetcher,{since:new Date(now-7*86400000).toISOString(),until:new Date(now).toISOString(),cursor:null})).items;
}
