// Public, anonymous endpoint used by HF's Posts frontend. Undocumented: schema
// changes fail the source rather than fabricating or silently truncating leads.
const ORIGIN='https://huggingface.co';
function safeLink(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.toString():null;}catch{return null;}
}
async function readPage(response){
 if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error('Invalid HF response');
 if(!response.body)throw Error('Missing HF response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw Error('HF response too large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const data=JSON.parse(new TextDecoder().decode(bytes));
 if(!Array.isArray(data?.socialPosts)||data.socialPosts.length>100)throw Error('HF schema changed');
 return data.socialPosts;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function collectHuggingFacePosts(config={},fetcher=fetch,now=Date.now(),sleep=pause){
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length)throw Error('HF config must be empty');
 const cutoff=now-7*86400000,seen=new Set(),items=[];
 const deadline=AbortSignal.timeout(60000);let skip=0;
 while(true){
  deadline.throwIfAborted();
  const posts=await readPage(await fetcher(`${ORIGIN}/api/posts?skip=${skip}&sort=recent`,{method:'GET',redirect:'error',signal:AbortSignal.any([deadline,AbortSignal.timeout(8000)]),headers:{Accept:'application/json','User-Agent':'WarpCorePublicNews/1.0'}}));
  if(!posts.length)return items;
  let oldest=Infinity,previous=Infinity,added=0;
  for(const p of posts){
   if(!p||typeof p.slug!=='string'||!/^\d{1,32}$/.test(p.slug)||typeof p.author?.name!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(p.author.name)||p.url!==`/posts/${p.author.name}/${p.slug}`||typeof p.rawContent!=='string'||!p.rawContent.trim()||p.rawContent.length>18000||!Array.isArray(p.content))throw Error('Invalid HF post');
   const date=typeof p.publishedAt==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(p.publishedAt)?Date.parse(p.publishedAt):NaN;
   if(!Number.isFinite(date)||date>previous)throw Error('Invalid HF chronology');
   previous=date;oldest=Math.min(oldest,date);
   const canonical=ORIGIN+p.url;
   if(seen.has(canonical))continue;
   seen.add(canonical);added++;
   if(date<cutoff||date>now+300000)continue;
   // Only retain an outbound link as evidence; never fetch it here. Native URL
   // retains the originating author's post even when a primary link is chosen.
   const link=p.content.map(c=>safeLink(c?.href??c?.url)).find(Boolean);
   items.push({id:canonical,url:link??canonical,nativeUrl:canonical,text:p.rawContent,author:p.author.name,publishedAt:new Date(date).toISOString(),visibility:'public'});
   if(items.length>500)throw Error('HF batch exceeds pipeline safety ceiling');
  }
  if(oldest<cutoff)return items;
  if(!added)throw Error('HF pagination made no progress');
  skip+=posts.length;
  await sleep(1000); // Polite same-domain pagination; deadline checked before GET.
 }
}
