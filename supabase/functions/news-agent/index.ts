import nodemailer from 'npm:nodemailer@10.6.0';
import {createHostedIncidentNotifier} from './notification-incidents.mjs';
import {createGmailFailureNotifier} from './gmail-alerts.mjs';
import {handleAgent} from './handler.mjs';
import {createAgentService} from './services.mjs';
import {createHostedApplication} from './hosted-application.mjs';
import {createVerificationService} from './verification-services.mjs';
import {runOwnerFeedbackInvocation} from './owner-feedback.mjs';
// Defaults off. Activation requires reviewed model/pricing/budgets, database
// installation and deployment provenance.
// Platform JWT verification is required in addition to this dedicated token.
let hosted;
Deno.serve((req:Request)=>{
 // Existing env-based installations keep their explicit gate. New deployment
 // uses protected database activation (default off) and private Vault bootstrap.
 if(!Deno.env.get('WARPCORE_AGENT_CRON_TOKEN')){
  hosted??=createHostedApplication({drain:true,projectUrl:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')},{createVerifierService:createVerificationService,runOwnerFeedbackInvocation,reportFeedbackFailure:(code:string)=>console.warn(code),notifyFailure:async (failure:unknown)=>createHostedIncidentNotifier({projectUrl:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),createTransport:nodemailer.createTransport,account:Deno.env.get('WARPCORE_ALERT_GMAIL_USERNAME'),password:Deno.env.get('WARPCORE_ALERT_GMAIL_APP_PASSWORD')},createGmailFailureNotifier)(failure)});
  return hosted(req);
 }
 let service:ReturnType<typeof createAgentService>;
 const getService=()=>service??=createAgentService({
  projectUrl:Deno.env.get('SUPABASE_URL'),
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  // Server-owned bounded settings; request data cannot override them.
  invocationOptions:{pageSteps:1,reviewBatchSize:4},
  runtimeConfig:{enabled:true,requireModelProfile:true,timeoutMs:60000,leaseSeconds:180,
   model:Deno.env.get('WARPCORE_AGENT_MODEL'),
   allowedModels:[Deno.env.get('WARPCORE_AGENT_MODEL')],
   maxOutputTokens:Number(Deno.env.get('WARPCORE_AGENT_MAX_OUTPUT_TOKENS')??'2048'),
   maxCostCredits:Number(Deno.env.get('WARPCORE_AGENT_MAX_COST_CREDITS')),
   apiKey:Deno.env.get('OPENROUTER_API_KEY'),
  },
 });
 return handleAgent(req,{enabled:Deno.env.get('WARPCORE_AGENT_ENABLED')==='true',producerToken:Deno.env.get('WARPCORE_AGENT_CRON_TOKEN')},{
  selectRun:()=>getService().selectRun(),
  runInvocation:(runId:string)=>getService().runInvocation(runId),
 });
});
