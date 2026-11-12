import {collect,validateConfig} from '../bluesky-collect/core.mjs';
// Adapter availability is not activation. No accounts or terms are selected here.
export const registry={bluesky:{collect:async config=>{
 validateConfig(config);
 // One actor per selection makes partial failures visible at the source level.
 if(config.actors.length!==1)throw new Error('One actor per source selection');
 const result=await collect(config);
 if(result.sources.some(s=>s.status!=='ok'))throw new Error('Source failed');
 return result.candidates.map(c=>{const parts=c.uri.split('/');return {
 id:c.uri,text:c.text,author:c.actor,publishedAt:c.created_at,visibility:'public',
 url:c.links.find(x=>{try{return new URL(x).protocol==='https:';}catch{return false;}}) || `https://bsky.app/profile/${encodeURIComponent(parts[2])}/post/${encodeURIComponent(parts.at(-1))}`};});
}}};
