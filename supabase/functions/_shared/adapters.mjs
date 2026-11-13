import {recordCollection,repostSubject} from './repost.mjs';
// Not wired to an endpoint. Credentials are injected by a future authorized runtime.
// No login/session creation or token refresh, retries, redirects, or secret logging.
export async function readJson(response){
 if(!response.ok)throw Error('Remote request failed');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1000000)throw Error('Response too large');chunks.push(value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
export function databaseAdapter(config,fetcher=fetch){
 const base=new URL(config.projectUrl);
 if(base.protocol!=='https:'||!base.hostname.endsWith('.supabase.co')||base.username||base.password||!config.serviceKey)throw Error('Invalid database configuration');
 const rpc=async(name,body)=>{const url=new URL(`/rest/v1/rpc/${name}`,base);return readJson(await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)}));};
 const params=j=>({p_account:j.accountDid,p_story:j.storyKey,p_hash:j.contentHash,p_record:j.record});
 return {
  reserveLogin:async account=>await rpc('warpcore_reserve_login',{p_account:account})===true,
  pending:async account=>{if(!/^did:plc:[a-z2-7]{24}$/.test(account))throw Error('Pinned DID required');
   const url=new URL('/rest/v1/warpcore_publications',base);
   url.search=new URLSearchParams({select:'*,warpcore_stories!inner(status)',account_did:'eq.'+account,approved_at:'not.is.null','warpcore_stories.status':'eq.approved',state:'in.(prepared,sending,uncertain)',order:'last_checked_at.asc.nullsfirst,prepared_at.asc',limit:'5'});
   const rows=await readJson(await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`}}));
   if(!Array.isArray(rows)||rows.length>5)throw Error('Invalid queue');
   return rows.map(r=>({accountDid:r.account_did,storyKey:r.story_key,contentHash:r.content_hash,recordKey:r.record_key,record:r.record_payload,state:r.state}));},
  checked:async j=>{if(await rpc('warpcore_mark_checked',params(j))!==true)throw Error('Check transition failed');},
  manualReview:async j=>{if(await rpc('warpcore_mark_manual_review',params(j))!==true)throw Error('Review transition failed');},
  review:async(j,approve)=>{if(typeof approve!=='boolean')throw Error('Explicit review decision required');return await rpc('warpcore_review_publication',{...params(j),p_approve:approve})===true;},
  prepare:async j=>{if(await rpc('warpcore_prepare_publication',{...params(j),p_key:j.recordKey})!==true)throw Error('Preparation conflict');return true;},
  claim:async j=>{const rows=await rpc('warpcore_claim_publication',params(j));if(!Array.isArray(rows))throw Error('Invalid claim response');if(!rows.length)return null;if(rows.length!==1)throw Error('Ambiguous claim');const r=rows[0];return {accountDid:r.account_did,storyKey:r.story_key,contentHash:r.content_hash,recordKey:r.record_key,record:r.record_payload};},
  uncertain:async j=>{if(await rpc('warpcore_mark_uncertain',params(j))!==true)throw Error('Durable transition failed');},
  published:async(j,uri)=>await rpc('warpcore_mark_published',{...params(j),p_uri:uri})===true,
 };
}
export function blueskyAdapter(config,fetcher=fetch){
 if(!/^did:plc:[a-z2-7]{24}$/.test(config.accountDid)||config.sessionDid!==config.accountDid||!config.accessToken)throw Error('Pinned account and authorized session required');
 const pds=new URL(config.pdsUrl);
 if(pds.protocol!=='https:'||pds.username||pds.password||pds.port||pds.search||pds.hash||pds.pathname!=='/'||!(pds.hostname==='bsky.social'||pds.hostname.endsWith('.bsky.network')))throw Error('Verified supported PDS required');
 function check(account,key){if(account!==config.accountDid||typeof key!=='string'||!/^[a-zA-Z0-9._~:-]{1,512}$/.test(key))throw Error('Account/key mismatch');}
 const request=async(url,method,body)=>readJson(await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${config.accessToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
 return {
  verifySubject:async subject=>{
   const original=repostSubject(subject),url=new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts');
   url.search=new URLSearchParams({'uris':original.uri});
   const result=await readJson(await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}}));
   return Array.isArray(result.posts)&&result.posts.length===1&&result.posts[0].uri===original.uri&&result.posts[0].cid===original.cid&&result.posts[0].author?.did===original.uri.split('/')[2];
  },
  put:async(account,key,record,options)=>{check(account,key);if(!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(key))throw Error('Post record key must be a TID');if(options?.swapRecord!==null)throw Error('Create-only required');return request(`${pds.origin}/xrpc/com.atproto.repo.putRecord`,'POST',{repo:account,collection:recordCollection(record),rkey:key,record,swapRecord:null,validate:true});},
  get:async(account,key,collection='app.bsky.feed.post')=>{check(account,key);if(!['app.bsky.feed.post','app.bsky.feed.repost'].includes(collection))throw Error('Unsupported collection');const query=new URLSearchParams({repo:account,collection,rkey:key});const result=await request(`${pds.origin}/xrpc/com.atproto.repo.getRecord?${query}`,'GET');return {record:result.value,uri:result.uri,cid:result.cid};},
 };
}
