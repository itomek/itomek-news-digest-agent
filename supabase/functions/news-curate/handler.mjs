import {authorized} from '../bluesky-collect/store.mjs';
// Database-only scheduled drain. No request-body drafts, credentials or enable flags.
export async function handleCurate(req,env,createService){
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!await authorized(req.headers.get('x-warpcore-token'),env.WARPCORE_PUBLISH_CRON_TOKEN))return new Response('Unauthorized',{status:401});
 if(env.WARPCORE_CURATE_ENABLED!=='true')return Response.json({mode:'disabled',processed:0});
 try{
  const service=createService({accountDid:env.BLUESKY_ACCOUNT_DID,dotId:env.WARPCORE_CURATOR_DOT_ID,projectUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY});
  const results=await service.drain();
  return Response.json({processed:results.length,states:results.map(r=>r.state),publishing_enabled:false});
 }catch{return Response.json({error:'curation_run_failed'},{status:502});}
}
