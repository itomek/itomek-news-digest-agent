// Source-neutral review queue contract. Adapters are trusted code, not names/URLs
// supplied in an HTTP request. No publishing or model calls occur in this module.
export const MAX_SOURCES=32;
export async function runAdapters(selections, registry) {
  if (!Array.isArray(selections) || selections.length > MAX_SOURCES) throw new Error('Invalid source selection');
  if(selections.filter(s=>s?.adapter==='hn').length>1)throw new Error('One HN discovery selection per run');
  const candidates=[], sources=[];
  const collectOne=async selection=>{
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(selection.id) || !/^[a-z0-9_-]{1,32}$/i.test(selection.adapter)) throw new Error('Invalid adapter identity');
      const adapter=Object.hasOwn(registry,selection.adapter) && registry[selection.adapter];
      if (!adapter || typeof adapter.collect !== 'function') throw new Error('Adapter unavailable');
      const items=await adapter.collect(selection.config ?? {});
      if (!Array.isArray(items) || items.length > 500) throw new Error('Invalid batch');
      const batch=items.map(item=>{
        if (item.visibility !== 'public' || typeof item.id !== 'string' || !item.id || item.id.length>2048 || typeof item.text !== 'string' || !item.text.trim() || item.text.length>20000 || !Number.isFinite(Date.parse(item.publishedAt))) throw new Error('Invalid public evidence');
        const url=new URL(item.url);
        if(url.protocol!=='https:' || url.username || url.password) throw new Error('Invalid evidence URL');
        let nativeUrl=null;
        if(item.nativeUrl!==undefined){
          const native=new URL(item.nativeUrl);
          if(native.protocol!=='https:'||native.username||native.password)throw new Error('Invalid native provenance URL');
          nativeUrl=native.toString();
        }
        if(item.nativeUri!==undefined&&(typeof item.nativeUri!=='string'||!item.nativeUri||item.nativeUri.length>2048))throw new Error('Invalid native provenance identity');
        return {uri:`urn:warpcore:${selection.adapter}:${selection.id}:${encodeURIComponent(item.id)}`,
          source_type:selection.adapter,source_id:selection.id,actor:item.author || selection.id,
          text:item.text,created_at:new Date(item.publishedAt).toISOString(),links:[...new Set([url.toString(),nativeUrl].filter(Boolean))],
          native_uri:item.nativeUri ?? null,native_url:nativeUrl,
          status:'unverified_review_required'};
      });
      return {batch,source:{id:selection.id,status:'ok',count:batch.length}};
    } catch { return {batch:[],source:{id:selection?.id ?? 'invalid',status:'error'}}; }
  };
  // Start the single slow HN scan first so it overlaps feed requests. Three
  // workers bound concurrency; output remains in the original roster order.
  const queue=selections.map((selection,index)=>({selection,index}));
  queue.sort((a,b)=>Number(b.selection?.adapter==='hn')-Number(a.selection?.adapter==='hn'));
  const results=new Array(selections.length);let cursor=0;
  const worker=async()=>{while(cursor<queue.length){const {selection,index}=queue[cursor++];results[index]=await collectOne(selection);}};
  await Promise.all(Array.from({length:Math.min(3,queue.length)},worker));
  for(const {batch,source} of results){candidates.push(...batch);sources.push(source);}
  return {candidates,sources,publishing_enabled:false};
}
