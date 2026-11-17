import {handleAgent} from './handler.mjs';
import {createAgentService} from './services.mjs';
// Inactive artifact. Enabling requires reviewed model/pricing/budgets, database
// installation, deployment provenance and explicit hosted-spike authorization.
// Platform JWT verification is required in addition to this dedicated token.
Deno.serve((req:Request)=>{
 let service:ReturnType<typeof createAgentService>;
 const getService=()=>service??=createAgentService({
  projectUrl:Deno.env.get('SUPABASE_URL'),
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  // Generic bounded spike settings; production remains disabled below.
  invocationOptions:{pageSteps:1,reviewBatchSize:4},
  runtimeConfig:{enabled:true,requireModelProfile:true,timeoutMs:30000,leaseSeconds:120,
   model:Deno.env.get('WARPCORE_AGENT_MODEL'),
   allowedModels:[Deno.env.get('WARPCORE_AGENT_MODEL')],
   maxOutputTokens:Number(Deno.env.get('WARPCORE_AGENT_MAX_OUTPUT_TOKENS')??'2048'),
   maxCostCredits:Number(Deno.env.get('WARPCORE_AGENT_MAX_COST_CREDITS')),
   apiKey:Deno.env.get('OPENROUTER_API_KEY'),
  },
 });
 return handleAgent(req,{enabled:false,producerToken:Deno.env.get('WARPCORE_AGENT_CRON_TOKEN')},{
  selectRun:()=>getService().selectRun(),
  runInvocation:(runId:string)=>getService().runInvocation(runId),
 });
});
