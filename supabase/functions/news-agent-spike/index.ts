import {handleAgent} from '../news-agent/handler.mjs';
import {createSpikeService} from './spike.mjs';
// Isolated, synthetic-only test entrypoint. Never forwards model/source HTTP.
// Deployment remains separate from this artifact; default state is disabled.
Deno.serve((req:Request)=>{
 let service:ReturnType<typeof createSpikeService>;
 const getService=()=>service??=createSpikeService({
  projectUrl:Deno.env.get('SUPABASE_URL'),projectRef:Deno.env.get('WARPCORE_SPIKE_PROJECT_REF'),
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),enabled:true,
 });
 return handleAgent(req,{enabled:Deno.env.get('WARPCORE_SPIKE_ENABLED')==='true',producerToken:Deno.env.get('WARPCORE_SPIKE_CRON_TOKEN')},{
  selectRun:()=>getService().selectRun(),
  runInvocation:(runId:string)=>getService().runInvocation(runId),
 });
});
