import {authorized} from '../bluesky-collect/store.mjs';
import {initialize} from '../_shared/runtime.mjs';
import {initializeWithPassword} from '../_shared/session.mjs';
// Scheduler cannot submit drafts, account IDs, enable flags or configuration.
export async function handlePublish(req,env,init=initialize){
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!await authorized(req.headers.get('x-warpcore-token'),env.WARPCORE_PUBLISH_CRON_TOKEN))return new Response('Unauthorized',{status:401});
 if(env.WARPCORE_PUBLISH_ENABLED!=='true')return Response.json({mode:'disabled',processed:0});
 try{
 const config={enabled:true,accountDid:env.BLUESKY_ACCOUNT_DID,pdsUrl:env.BLUESKY_PDS_URL,accessToken:env.BLUESKY_ACCESS_TOKEN,projectUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY};
 const runtime=env.BLUESKY_APP_PASSWORD?await initializeWithPassword({...config,identifier:env.BLUESKY_IDENTIFIER,appPassword:env.BLUESKY_APP_PASSWORD},init):await init(config);
 const results=await runtime.runPending();
 return Response.json({processed:results.length,states:results.map(r=>r.state)});
 }catch{return Response.json({error:'publication_run_failed'},{status:502});}
}
