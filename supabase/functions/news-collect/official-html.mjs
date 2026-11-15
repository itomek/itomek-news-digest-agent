// Public official publisher indexes only. Never execute embedded scripts or follow
// article URLs here; full primary-article verification belongs to the curator.
const URLS=new Set(['https://www.anthropic.com/news','https://www.anthropic.com/research','https://www.perplexity.ai/hub/blog']);
const plain=v=>String(v??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export function parseOfficialHTML(html,config,now=Date.now(),window=null){
 if(!URLS.has(config?.url)||typeof html!=='string'||new TextEncoder().encode(html).length>1000000)throw Error('Invalid official index');
 const items=[];
 if(config.url.startsWith('https://www.anthropic.com/')){
  // Select only visible dated article/listing containers, not hydration scripts.
  const visible=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const blocks=[...visible.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>|<li\b[^>]*data-listing-row="[^"]+"[^>]*>([\s\S]*?)<\/li>/gi)];
  if(!blocks.length)throw Error('Official index layout changed');
  for(const match of blocks){
   const block=match[1]??match[2],date=block.match(/<time\b[^>]*>([^<]+)<\/time>/i)?.[1];
   let link=[...block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].find(m=>/<h[23]\b/i.test(m[2]));
   const heading=block.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1];
   if(!link&&heading){const nested=heading.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);if(nested)link=[nested[0],nested[1],'<h3>'+nested[2]+'</h3>'];}
   if(!link||!date||!/^\/[a-z0-9][a-z0-9/-]*$/.test(link[1]))continue;
   items.push({url:'https://www.anthropic.com'+link[1],title:plain(link[2].match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1]),summary:plain(block.match(/<p\b[^>]*>([^<]+)<\/p>/i)?.[1]),date});
  }
  if(!items.length)throw Error('Official index entries missing');
 }else{
  const raw=html.match(/window\.__PPL_INITIAL_SERVER_DATA__=(\{[^\n]*?\});window\.__PPL_INITIAL_SESSION__=/)?.[1];
  if(!raw)throw Error('Official index layout changed');
  const data=JSON.parse(raw);let nodes=0;
  const visit=(v,depth=0)=>{
   if(depth>30||++nodes>10000)throw Error('Index structure too large');
   if(!v||typeof v!=='object')return;
   if(typeof v.slug==='string'&&typeof v.title==='string'&&typeof v.publishedAt==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(v.slug))items.push({url:'https://www.perplexity.ai/hub/blog/'+v.slug,title:plain(v.title),summary:plain(v.summary),date:v.publishedAt});
   for(const child of Object.values(v))visit(child,depth+1);
  };visit(data);
  if(!items.length)throw Error('Official index entries missing');
 }
 const seen=new Set();return items.flatMap(e=>{
  // Date-only source dates remain UTC midnight; no invented retrieval timestamp.
  const date=/^\d{4}-\d{2}-\d{2}$/.test(e.date)?e.date+'T00:00:00Z':/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(e.date)?e.date+' UTC':/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(e.date)?e.date:'';
  const published=Date.parse(date);if(!e.title||!Number.isFinite(published)||published>(window?Date.parse(window.until):now+300000)||published<(window?Date.parse(window.since):now-7*86400000)||seen.has(e.url))return [];
  seen.add(e.url);return [{id:e.url,url:e.url,text:[e.title,e.summary].filter(Boolean).join('\n').slice(0,18000),author:config.label,publishedAt:new Date(published).toISOString(),visibility:'public'}];
 });
}
function diagnostic(code){return Object.assign(new Error(code),{code});}
function networkDiagnostic(error){return diagnostic(error?.name==='TimeoutError'||error?.name==='AbortError'?'source_timeout':'source_network');}
export async function collectOfficialHTML(config,fetcher=fetch,now=Date.now(),window=null){
 if(!URLS.has(config?.url)||typeof config.label!=='string'||!config.label.trim())throw Error('Trusted labeled official index required');
 let r;
 try{r=await fetcher(config.url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; WarpCorePublicNews/1.0)'}});}
 catch(error){throw networkDiagnostic(error);}
 if(!r.ok)throw diagnostic(`source_http_${r.status}`);
 if(!/^text\/html(?:;|$)/i.test(r.headers.get('content-type')||''))throw diagnostic('source_content_type');
 const chunks=[];let size=0,reader;
 try{
  reader=r.body?.getReader();if(!reader)throw diagnostic('source_network');
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw diagnostic('source_body_limit');chunks.push(value);}
 }catch(error){if(error?.code==='source_body_limit'||error?.code==='source_network')throw error;throw networkDiagnostic(error);}
 finally{if(reader)await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return parseOfficialHTML(new TextDecoder().decode(bytes),config,now,window);}
 catch{throw diagnostic('source_parse_failed');}
}

// A finite snapshot scan cannot certify retained, late, or re-dated history.
export async function collectOfficialHTMLPage(config,fetcher=fetch,window={}){
 const since=Date.parse(window.since),until=Date.parse(window.until);
 if(!Number.isFinite(since)||!Number.isFinite(until)||since>until||window.cursor!=null)throw Error('Invalid sync window');
 const items=await collectOfficialHTML(config,fetcher,until,{since:new Date(0).toISOString(),until:window.until});
 const earliestAvailableAt=items.length?new Date(Math.min(...items.map(x=>Date.parse(x.publishedAt)))).toISOString():null;
 return {items,complete:true,cursor:null,earliestAvailableAt,coverageGap:true,gapReason:'finite_index_history',fetchedCount:items.length};
}
