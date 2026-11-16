import {handleHaloShadow} from './serve.mjs';
Deno.serve({hostname:'0.0.0.0',port:8000},(req:Request)=>handleHaloShadow(req,{
 JWT_SECRET:Deno.env.get('JWT_SECRET'),
 WARPCORE_AGENT_PRODUCER_TOKEN:Deno.env.get('WARPCORE_AGENT_PRODUCER_TOKEN'),
 HALO_SHADOW_ENABLED:Deno.env.get('HALO_SHADOW_ENABLED'),
 HALO_SHADOW_LEASE_SECONDS:Deno.env.get('HALO_SHADOW_LEASE_SECONDS'),
}));
