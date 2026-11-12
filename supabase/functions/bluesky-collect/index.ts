import { collect, validateConfig } from './core.mjs';
import { authorized, persist } from './store.mjs';
// Deploy with verify_jwt=true AND this dedicated scheduler token, never JWT alone.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST required', {status:405});
  if (!await authorized(req.headers.get('x-warpcore-token'),Deno.env.get('WARPCORE_CRON_TOKEN'))) return new Response('Unauthorized',{status:401});
  let config;
  try { config = validateConfig(JSON.parse(Deno.env.get('BLUESKY_SOURCE_CONFIG') ?? '{}')); }
  catch { return Response.json({error:'verified_source_roster_required'}, {status:503}); }
  const result = await collect(config);
  if (!result.sources.some(s => s.status === 'ok')) return Response.json({error:'all_sources_failed',sources:result.sources},{status:502});
  try {
    const submitted = await persist(result.candidates,{projectUrl:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
    return Response.json({mode:'review_only',publishing_enabled:false,candidates_submitted:submitted,sources:result.sources});
  } catch { return Response.json({error:'persistence_failed'},{status:502}); }
});
