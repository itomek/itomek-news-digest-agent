import {runAdapters} from '../_shared/pipeline.mjs';
import {authorized,persist} from '../bluesky-collect/store.mjs';
export async function handle(req, env, registry, save=persist) {
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!await authorized(req.headers.get('x-warpcore-token'),env.WARPCORE_CRON_TOKEN))return new Response('Unauthorized',{status:401});
 let selections;
 try {selections=JSON.parse(env.NEWS_SOURCE_CONFIG ?? '[]');if(!Array.isArray(selections)||selections.length>10)throw Error();}
 catch{return Response.json({error:'invalid_source_configuration'},{status:503});}
 if(!selections.length)return Response.json({mode:'idle',publishing_enabled:false,candidates_submitted:0});
 const result=await runAdapters(selections,registry);
 if(!result.sources.some(s=>s.status==='ok'))return Response.json({error:'all_sources_failed',sources:result.sources},{status:502});
 try {const submitted=await save(result.candidates,{projectUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY});
 return Response.json({mode:'review_only',publishing_enabled:false,candidates_submitted:submitted,sources:result.sources});}
 catch{return Response.json({error:'persistence_failed'},{status:502});}
}
