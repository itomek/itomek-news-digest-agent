// Public official publisher indexes only. Never execute embedded scripts or follow
// article URLs here; full primary-article verification belongs to the curator.
const URLS=new Set(['https://x.ai/news','https://www.virgingalactic.com/news','https://www.anthropic.com/news','https://www.anthropic.com/research','https://www.perplexity.ai/hub/blog']);
const plain=v=>String(v??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export function parseOfficialHTML(html,config,now=Date.now()){
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
 }else if(config.url==='https://x.ai/news'||config.url==='https://www.virgingalactic.com/news'){
  const visible=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  for(const match of visible.matchAll(/<a\b[^>]*href="(\/news\/[a-z0-9][a-z0-9-]*)"[^>]*>([\s\S]*?)<\/a>/gi)){
   const block=match[2];
   const date=[...block.matchAll(/<p\b[^>]*>([^<]+)<\/p>/gi)].map(m=>m[1].trim()).find(v=>/^[A-Z][a-z]{2,8} \d{1,2}, \d{4}$/.test(v));
   const title=config.url==='https://x.ai/news'?block.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]:block.match(/<p\b[^>]*class="[^"]*\bfont-title-lg\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1];
   if(date&&title)items.push({url:new URL(config.url).origin+match[1],title:plain(title),date});
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
  const date=/^\d{4}-\d{2}-\d{2}$/.test(e.date)?e.date+'T00:00:00Z':/^[A-Z][a-z]{2,8} \d{1,2}, \d{4}$/.test(e.date)?e.date+' UTC':/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(e.date)?e.date:'';
  const published=Date.parse(date);if(!e.title||!Number.isFinite(published)||published>now+300000||published<now-7*86400000||seen.has(e.url))return [];
  seen.add(e.url);return [{id:e.url,url:e.url,text:[e.title,e.summary].filter(Boolean).join('\n').slice(0,18000),author:config.label,publishedAt:new Date(published).toISOString(),visibility:'public'}];
 });
}
export async function collectOfficialHTML(config,fetcher=fetch,now=Date.now()){
 if(!URLS.has(config?.url)||typeof config.label!=='string'||!config.label.trim())throw Error('Trusted labeled official index required');
 const r=await fetcher(config.url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; WarpCorePublicNews/1.0)'}});
 if(!r.ok||!/^text\/html(?:;|$)/i.test(r.headers.get('content-type')||''))throw Error('Invalid official index response');
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw Error('Official index too large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return parseOfficialHTML(new TextDecoder().decode(bytes),config,now);
}
