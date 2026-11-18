import {collectHuggingFacePosts,collectHuggingFacePostsPage} from './huggingface-posts.mjs';
import {collectGithubPR,collectGithubPRPage} from './github-pr.mjs';
import {collectOfficialHTML,collectOfficialHTMLPage} from './official-html.mjs';
import {collectRSS,collectRSSPage} from './rss.mjs';
import {collectHN,collectHNPage} from './hn.mjs';
import {collect,validateConfig,collectBlueskyPage} from '../bluesky-collect/core.mjs';
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
  return {id:c.uri,nativeUri:c.uri,nativeUrl,...(c.native_cid?{nativeCid:c.native_cid,nativeAuthorDid:c.native_author_did}:{}),text:c.text,author:c.actor,publishedAt:c.created_at,visibility:'public',
   url:c.links.find(x=>{try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}) || nativeUrl};
 });
}};}
export const registry={
 huggingface_posts:{collect:collectHuggingFacePosts,collectPage:(config,window)=>collectHuggingFacePostsPage(config,fetch,window)},
 github_pr:{collect:collectGithubPR,collectPage:(config,window)=>collectGithubPRPage(config,fetch,window)},
 official_html:{collect:collectOfficialHTML,collectPage:(config,window)=>collectOfficialHTMLPage(config,fetch,window)},
 bluesky:{...createBlueskyAdapter(),collectPage:(config,window)=>collectBlueskyPage(config,fetch,window)},
 rss:{collect:collectRSS,collectPage:(config,window)=>collectRSSPage(config,fetch,window)},
 hn:{collect:async config=>(await collectHN(config)).map(x=>({...x,nativeUrl:x.discussion_url})),collectPage:async(config,window)=>{const page=await collectHNPage(config,fetch,window);return {...page,items:page.items.map(x=>({...x,nativeUrl:x.discussion_url}))};}},
};
