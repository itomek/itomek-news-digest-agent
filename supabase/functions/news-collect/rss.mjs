import {XMLParser,XMLValidator} from 'fast-xml-parser';
// Reviewed public publisher destinations only; no arbitrary DNS names or redirects.
const MOTORSPORT_F1='https://www.motorsport.com/rss/f1/news/';
const FEEDS=new Set(['https://ir.amd.com/news-events/press-releases/rss',MOTORSPORT_F1,'https://blogs.nvidia.com/feed/','https://supabase.com/rss.xml','https://firebase.blog/rss.xml','https://github.blog/feed/','https://newsroom.arm.com/feed','https://www.apple.com/newsroom/rss-feed.rss','https://www.pensburgh.com/rss/index.xml','https://www.formula1.com/en/latest/all.xml',"https://openai.com/news/rss.xml","https://blog.google/innovation-and-ai/technology/ai/rss/","https://deepmind.google/blog/rss.xml","https://mistral.ai/news/rss","https://rocm.blogs.amd.com/blog/atom.xml","https://huggingface.co/blog/feed.xml","https://github.com/lemonade-sdk/lemonade/releases.atom","https://github.com/ROCm/TheRock/releases.atom","https://github.com/ggml-org/llama.cpp/releases.atom","https://github.com/vllm-project/vllm/releases.atom","https://github.com/ollama/ollama/releases.atom","https://github.com/ml-explore/mlx/releases.atom","https://devblogs.microsoft.com/dotnet/feed/","https://devblogs.microsoft.com/visualstudio/feed/","https://newsroom.arm.com/feed","https://omarchy.org/news/rss.xml","https://milfordtownship.org/feed/","https://buckslib.org/feed/"]);
const array=v=>v===undefined?[]:Array.isArray(v)?v:[v];
const plain=v=>String(typeof v==='object'?v?.['#text']??'':v??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function safe(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^\d|localhost|\.local$/.test(u.hostname)||u.hostname.startsWith('['))return null;return u.toString();}catch{return null;}}
// Feed URLs are trusted configuration, never taken from request bodies or items.
export function parseFeed(xml,config={},now=Date.now()){
 if(typeof xml!=='string'||new TextEncoder().encode(xml).length>1000000||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw Error('Unsafe or invalid XML');
 const parsed=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true}).parse(xml);
 const entries=parsed.rss?.channel?.item??parsed.feed?.entry;
 if(entries===undefined)return [];
 const out=[];
 for(const e of array(entries).slice(0,100)){
 const link=typeof e.link==='string'?e.link:array(e.link).find(x=>!x['@_rel']||x['@_rel']==='alternate')?.['@_href'];
 const url=safe(link),published=Date.parse(e.pubDate??e.published??e.updated),title=plain(e.title);
 if(!url||!title||!Number.isFinite(published)||published>now+300000||published<now-7*86400000)continue;
 // Discovery filter only, never editorial verification or approval. Team names
 // must occur in the title; body mentions and driver-only stories are insufficient.
 if(config.url===MOTORSPORT_F1&&(!/\b(?:Haas|Cadillac|Mercedes)\b/i.test(title)||/\b(?:merchandise|merch|shirts?|t-shirts?|(?:team|baseball)\s+caps?|hoodies?|fashion|lifestyle|weddings?|girlfriends?|boyfriends?|vacations?|holidays?|shopping|discounts?)\b/i.test(title)))continue;
 const detail=plain(e.description??e.summary??e.content??e['content:encoded']);
 const text=[title,detail].filter(Boolean).join('\n').slice(0,18000);
 out.push({id:plain(e.guid??e.id)||url,url,text,author:config.label||'RSS source',publishedAt:new Date(published).toISOString(),visibility:'public'});
 if(out.length>=20)break;
 }
 return out;
}
export async function collectRSS(config,fetcher=fetch,now=Date.now()){
 const url=safe(config?.url);if(!url||!FEEDS.has(url)||typeof config.label!=='string'||!config.label.trim())throw Error('Trusted labeled feed required');
 const r=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml'}});
 if(!r.ok||!(/(xml|rss|atom)/i.test(r.headers.get('content-type')||'')||(url==='https://mistral.ai/news/rss'&&/^text\/plain(?:;|$)/i.test(r.headers.get('content-type')||''))))throw Error('Invalid feed response');
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw Error('Feed too large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return parseFeed(new TextDecoder().decode(bytes),config,now);
}
