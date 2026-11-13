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
export async function collect(config, fetcher = fetch, now = Date.now()) {
  validateConfig(config);
  const seen = new Set(), candidates = [], sources = [];
  for (const actor of new Set(config.actors)) {
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
      url.search = new URLSearchParams({actor:config.actorDids?.[actor]??actor,limit:'50',filter:'posts_no_replies'}).toString();
      const response = await fetcher(url, {redirect:'error', signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('Source HTTP error');
      const reader = response.body.getReader(); let size=0; const chunks=[];
      try { while (true) { const {done,value}=await reader.read(); if(done)break;
        size+=value.byteLength; if(size>1_000_000)throw new Error('Source too large'); chunks.push(value);
      }} finally { await reader.cancel(); }
      const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const data=JSON.parse(new TextDecoder().decode(bytes));
      if(!Array.isArray(data.feed))throw new Error('Malformed source');
      for(const item of data.feed.slice(0,50)) {
        const post=item.post, record=post?.record;
        if(item.reason || record?.reply || typeof record?.text!=='string' || typeof post?.uri!=='string' || !post.uri.startsWith('at://'))continue;
        const pinned=config.actorDids?.[actor];
        if(pinned){try{repostSubject({uri:post.uri,cid:post.cid});if(post.author?.did!==pinned||post.uri.split('/')[2]!==pinned)continue;}catch{continue;}}
        const date=Date.parse(record.createdAt);
        if(!Number.isFinite(date)||date>now||date<now-86400000||seen.has(post.uri))continue;
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
