import {createHostedApplication} from './hosted-application.mjs';
// Hosted live-feed discovery acceptance only. This deployed entrypoint cannot
// invoke source verification, submit an inbox decision, or call the publisher.
// The administrator-owned producer and spending gates still default off.
const handler=createHostedApplication({
 projectUrl:Deno.env.get('SUPABASE_URL'),
 serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
},{createVerifierService:()=>({runInvocation:async()=>({status:'disabled'})})});
Deno.serve(handler);
