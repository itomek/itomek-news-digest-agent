import {handlePublish} from './handler.mjs';
// Proposed endpoint only. Deployment must enable platform verify_jwt=true too.
Deno.serve((req:Request)=>handlePublish(req,{
 WARPCORE_PUBLISH_CRON_TOKEN:Deno.env.get('WARPCORE_PUBLISH_CRON_TOKEN'),
 WARPCORE_PUBLISH_ENABLED:Deno.env.get('WARPCORE_PUBLISH_ENABLED'),
 BLUESKY_ACCOUNT_DID:Deno.env.get('BLUESKY_ACCOUNT_DID'),
 BLUESKY_PDS_URL:Deno.env.get('BLUESKY_PDS_URL'),
 BLUESKY_ACCESS_TOKEN:Deno.env.get('BLUESKY_ACCESS_TOKEN'),
 SUPABASE_URL:Deno.env.get('SUPABASE_URL'),
 SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
}));
