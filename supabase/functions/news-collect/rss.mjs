import {XMLParser,XMLValidator} from 'fast-xml-parser';
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
 const detail=plain(e.description??e.summary??e.content??e['content:encoded']);
 const text=[title,detail].filter(Boolean).join('\n').slice(0,18000);
 out.push({id:plain(e.guid??e.id)||url,url,text,author:config.label||'RSS source',publishedAt:new Date(published).toISOString(),visibility:'public'});
 if(out.length>=20)break;
 }
 return out;
}
export async function collectRSS(config,fetcher=fetch,now=Date.now()){
 const url=safe(config?.url);if(!url||typeof config.label!=='string'||!config.label.trim())throw Error('Trusted labeled feed required');
 const r=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml'}});
 if(!r.ok||!/(xml|rss|atom)/i.test(r.headers.get('content-type')||''))throw Error('Invalid feed response');
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw Error('Feed too large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return parseFeed(new TextDecoder().decode(bytes),config,now);
}
