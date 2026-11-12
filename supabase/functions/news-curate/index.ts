import {handleCurate} from './handler.mjs';
import {createCuratorService} from './services.mjs';
// Platform verify_jwt=true is required as well as the dedicated publish token.
Deno.serve((req:Request)=>handleCurate(req,{
 WARPCORE_PUBLISH_CRON_TOKEN:Deno.env.get('WARPCORE_PUBLISH_CRON_TOKEN'),
 WARPCORE_CURATE_ENABLED:'false', // Reviewed code change required before activation.
 WARPCORE_CURATOR_DOT_ID:Deno.env.get('WARPCORE_CURATOR_DOT_ID'),
 BLUESKY_ACCOUNT_DID:Deno.env.get('BLUESKY_ACCOUNT_DID'),
 SUPABASE_URL:Deno.env.get('SUPABASE_URL'),
 SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
},createCuratorService));
