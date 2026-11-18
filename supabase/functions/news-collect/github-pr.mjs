// Owner-selected project only. A merge is discovery, not a claim that it shipped.
const repo='lemonade-sdk/lemonade',base='https://api.github.com/repos/'+repo+'/pulls';
export async function collectGithubPRPage(config,fetcher=fetch,window={}){
 if(config?.repo!==repo||window.cursor!=null||!Number.isFinite(Date.parse(window.since))||!Number.isFinite(Date.parse(window.until)))throw Error('Invalid PR source');
 const items=[],started=Date.now();let complete=false;
 for(let page=1;page<=8;page++){
  if(Date.now()-started>25000)throw Error('PR source deadline');
  const response=await fetcher(base+'?state=closed&sort=updated&direction=desc&per_page=20&page='+page,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/vnd.github+json'}});
  if(!response.ok)throw Object.assign(Error('PR source failed'),{code:'source_http_'+response.status});
  const reader=response.body?.getReader();if(!reader)throw Error('Empty PR source');let bytes=0,chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1000000)throw Error('PR source too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  const rows=JSON.parse(new TextDecoder().decode(buffer));if(!Array.isArray(rows)||rows.length>20)throw Error('Invalid PR response');
  for(const row of rows){
   if(!Number.isSafeInteger(row.number)||row.number<1||row.html_url!=='https://github.com/'+repo+'/pull/'+row.number||!Number.isFinite(Date.parse(row.updated_at)))throw Error('Invalid PR identity');
   if(!row.merged_at)continue;const date=Date.parse(row.merged_at);if(!Number.isFinite(date))throw Error('Invalid PR date');
   if(date<Date.parse(window.since)||date>Date.parse(window.until))continue;
   if(row.base?.repo?.full_name!==repo||typeof row.title!=='string')throw Error('Invalid merged PR');
   items.push({id:String(row.number),url:row.html_url,nativeUrl:base+'/'+row.number,text:'Merged Lemonade PR #'+row.number+': '+row.title+'\n'+String(row.body??'').slice(0,15000)+'\nMerged '+row.merged_at+'; merge does not establish release availability.',author:'Lemonade',publishedAt:row.merged_at,visibility:'public'});
  }
  if(rows.length<20||rows.every(row=>Date.parse(row.updated_at)<Date.parse(window.since))){complete=true;break;}
 }
 if(!complete)throw Error('PR window incomplete');
 return {items,complete:true,cursor:null,coverageGap:false,fetchedCount:items.length};
}
export async function collectGithubPR(config,fetcher=fetch,now=Date.now()){return (await collectGithubPRPage(config,fetcher,{since:new Date(now-7*86400000).toISOString(),until:new Date(now).toISOString()})).items;}
