import {MAX_SOURCES} from '../_shared/pipeline.mjs';
import {authorized} from '../bluesky-collect/store.mjs';
import {createCheckpointStore,syncSources} from './checkpoints.mjs';
export async function handle(req, env, registry, options={}) {
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!await authorized(req.headers.get('x-warpcore-token'),env.WARPCORE_CRON_TOKEN))return new Response('Unauthorized',{status:401});
 let selections;
 try {selections=JSON.parse(env.NEWS_SOURCE_CONFIG ?? '[]');if(!Array.isArray(selections)||selections.length>MAX_SOURCES||selections.filter(s=>s?.adapter==='hn').length>1||new Set(selections.map(s=>`${s?.adapter}:${s?.id}`)).size!==selections.length)throw Error();}
 catch{return Response.json({error:'invalid_source_configuration'},{status:503});}
 // Recovery can narrow the approved roster, never supply new sources/config.
 try{
  const reader=req.body?.getReader();let text='',bytes=0;
  if(reader){const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096)throw Error();text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();}}
  const input=text?JSON.parse(text):{};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='source_ids'))throw Error();
  if(input.source_ids!==undefined){
   const ids=input.source_ids;
   if(!Array.isArray(ids)||!ids.length||ids.length>MAX_SOURCES||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-z0-9_-]{1,64}$/i.test(id)||!selections.some(source=>source.id===id)))throw Error();
   selections=selections.filter(source=>ids.includes(source.id));
  }
 }catch{return Response.json({error:'invalid_source_selection'},{status:400});}
 if(!selections.length)return Response.json({mode:'idle',publishing_enabled:false,candidates_submitted:0});
 try{
  const result=await syncSources(selections,registry,options.store??createCheckpointStore(env),options.upper);
  const allFailed=result.sources.every(source=>source.status==='failed');
  return Response.json({mode:'review_only',publishing_enabled:false,...result,...(allFailed?{error:'all_sources_failed'}:{})},{status:allFailed?502:200});
 }catch{return Response.json({error:'checkpoint_persistence_unavailable'},{status:502});}
}
