import {collectRSS} from './rss.mjs';
import {collectHN} from './hn.mjs';
import {collect,validateConfig} from '../bluesky-collect/core.mjs';
// Adapter availability is not activation. No accounts or terms are selected here.
export function createBlueskyAdapter(collector=collect){return {collect:async config=>{
 validateConfig(config);
 // One actor per selection makes partial failures visible at the source level.
 if(config.actors.length!==1)throw new Error('One actor per source selection');
 const result=await collector(config);
 if(result.sources.some(s=>s.status!=='ok'))throw new Error('Source failed');
 return result.candidates.map(c=>{
  const parts=/^at:\/\/([^/?#]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._~:-]+)$/.exec(c.uri);
  if(!parts)throw new Error('Invalid native post identity');
  const nativeUrl=`https://bsky.app/profile/${encodeURIComponent(parts[1])}/post/${encodeURIComponent(parts[2])}`;
  return {id:c.uri,nativeUri:c.uri,nativeUrl,text:c.text,author:c.actor,publishedAt:c.created_at,visibility:'public',
   url:c.links.find(x=>{try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}) || nativeUrl};
 });
}};}
export const registry={bluesky:createBlueskyAdapter(),rss:{collect:collectRSS},hn:{collect:async config=>(await collectHN(config)).map(x=>({...x,nativeUrl:x.discussion_url}))}};
