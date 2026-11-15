import {repostSubject} from '../_shared/repost.mjs';
// Public social content is untrusted evidence, never executable instructions.
export function validateConfig(config) {
  if (!Array.isArray(config.actors) || !config.actors.length || config.actors.length > 10 ||
      config.actors.some(a => typeof a !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,252}$/.test(a))) throw new Error('Configure 1–10 verified source handles');
  if (!Array.isArray(config.terms) || !config.terms.length || config.terms.length > 50 ||
      config.terms.some(t => typeof t !== 'string' || !t.trim() || t.length > 80)) throw new Error('Configure 1–50 relevance terms');
  if(config.actorDids!==undefined&&(typeof config.actorDids!=='object'||config.actorDids===null||Array.isArray(config.actorDids)||config.actors.some(a=>typeof config.actorDids[a]!=='string'||!/^did:plc:[a-z2-7]{24}$/.test(config.actorDids[a]))))throw Error('Pinned source DIDs required');
  return config;
}
export async function collect(config, fetcher = fetch, now = Date.now(), window = null) {
  validateConfig(config);
  const seen = new Set(), candidates = [], sources = [];
  for (const actor of new Set(config.actors)) {
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
      url.search = new URLSearchParams({actor:config.actorDids?.[actor]??actor,limit:window?'100':'50',filter:'posts_no_replies',...(window?.cursor?{cursor:window.cursor}:{})}).toString();
      const response = await fetcher(url, {redirect:'error', signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('Source HTTP error');
      const reader = response.body.getReader(); let size=0; const chunks=[];
      try { while (true) { const {done,value}=await reader.read(); if(done)break;
        size+=value.byteLength; if(size>1_000_000)throw new Error('Source too large'); chunks.push(value);
      }} finally { await reader.cancel(); }
      const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const data=JSON.parse(new TextDecoder().decode(bytes));
      if(!Array.isArray(data.feed))throw new Error('Malformed source');
      if(window){
       if(data.feed.length>100||data.cursor!==undefined&&(typeof data.cursor!=='string'||!data.cursor||data.cursor.length>4096))throw Error('Malformed source cursor');
       window.nextCursor=data.cursor??null;window.fetchedCount=data.feed.length;
       const dates=data.feed.map(x=>Date.parse(x.post?.record?.createdAt)).filter(Number.isFinite);
       window.earliest=dates.length?Math.min(...dates):null;
       window.malformed=data.feed.some(x=>!Number.isFinite(Date.parse(x.post?.record?.createdAt)));
      }
      for(const item of data.feed.slice(0,window?100:50)) {
        const post=item.post, record=post?.record;
        if(item.reason || record?.reply)continue;
        if(typeof record?.text!=='string'||typeof post?.uri!=='string'||!post.uri.startsWith('at://')){if(window)throw Error('Malformed original evidence');continue;}
        if(window&&!/^at:\/\/([^/?#]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._~:-]+)$/.test(post.uri))throw Error('Malformed original identity');
        const pinned=config.actorDids?.[actor];
        if(pinned){try{repostSubject({uri:post.uri,cid:post.cid});if(post.author?.did!==pinned||post.uri.split('/')[2]!==pinned)throw Error('Original author mismatch');}catch(error){if(window)throw error;continue;}}
        const date=Date.parse(record.createdAt);
        if(!Number.isFinite(date)||date>now||date<(window?Date.parse(window.since):now-86400000)||seen.has(post.uri))continue;
        const external = record.embed?.external;
        const text = [record.text, external?.title, external?.description].filter(x=>typeof x === 'string').join('\n').slice(0,5000);
        if(!config.terms.some(term=>text.toLowerCase().includes(term.toLowerCase())))continue;
        seen.add(post.uri);
        const links = (record.facets ?? []).flatMap(f => (f.features ?? []).map(x => x.uri)).filter(x => typeof x === 'string');
        if (typeof record.embed?.external?.uri === 'string') links.push(record.embed.external.uri);
        candidates.push({uri:post.uri,actor,links:links.slice(0,10),text,created_at:record.createdAt,...(pinned?{source_type:'bluesky',native_uri:post.uri,native_url:`https://bsky.app/profile/${encodeURIComponent(pinned)}/post/${post.uri.split('/').at(-1)}`,native_cid:post.cid,native_author_did:pinned}:{}),status:'unverified_review_required'});
      }
      sources.push({actor,status:'ok'});
    } catch { sources.push({actor,status:'error'}); }
  }
  return {mode:'review_only',publishing_enabled:false,candidates,sources};
}

// Scan to upstream exhaustion: creation/publication times are not a safe ordering
// assumption (late records, pins and edits can appear behind a time boundary).
export async function collectBlueskyPage(config,fetcher=fetch,window={}){
 validateConfig(config);
 const since=Date.parse(window.since),until=Date.parse(window.until),actor=config.actors[0];
 if(config.actors.length!==1||!Number.isFinite(since)||!Number.isFinite(until)||since>until)throw Error('Invalid Bluesky sync window');
 let cursor=null;
 if(window.cursor!=null){const c=window.cursor;if(c.since!==window.since||c.until!==window.until||c.actor!==actor||typeof c.token!=='string'||!c.token||c.token.length>4096)throw Error('Invalid Bluesky cursor');cursor=c.token;}
 const scan={since:new Date(0).toISOString(),cursor};
 const result=await collect(config,fetcher,until,scan);
 if(result.sources.some(x=>x.status!=='ok'))throw Error('Bluesky source failed');
 if(scan.nextCursor&&scan.nextCursor===cursor)throw Error('Non-progressing Bluesky cursor');
 const items=result.candidates.map(c=>{
  const parts=/^at:\/\/([^/?#]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._~:-]+)$/.exec(c.uri);
  if(!parts)throw Error('Invalid native post identity');
  const nativeUrl=`https://bsky.app/profile/${encodeURIComponent(parts[1])}/post/${encodeURIComponent(parts[2])}`;
  return {id:c.uri,nativeUri:c.uri,nativeUrl,...(c.native_cid?{nativeCid:c.native_cid,nativeAuthorDid:c.native_author_did}:{}),text:c.text,author:c.actor,publishedAt:c.created_at,visibility:'public',url:c.links.find(x=>{try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}})||nativeUrl};
 });
 return {items,complete:!scan.nextCursor,cursor:scan.nextCursor?{token:scan.nextCursor,since:window.since,until:window.until,actor}:null,earliestAvailableAt:scan.earliest!==null?new Date(scan.earliest).toISOString():null,coverageGap:scan.malformed,gapReason:scan.malformed?'malformed_source_dates':null,fetchedCount:scan.fetchedCount};
}
