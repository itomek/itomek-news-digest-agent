import {handle} from './handler.mjs';
import {registry} from './adapters.mjs';
// Deployment must require verify_jwt=true in addition to the dedicated token.
Deno.serve((req: Request)=>handle(req,{
 WARPCORE_CRON_TOKEN:Deno.env.get('WARPCORE_CRON_TOKEN'),
 NEWS_SOURCE_CONFIG:'[]', // Deployment safety lock: source selection is deferred.,
 SUPABASE_URL:Deno.env.get('SUPABASE_URL'),
 SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
},registry));
