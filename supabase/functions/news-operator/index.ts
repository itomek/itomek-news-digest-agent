import {handleOperator} from './handler.mjs';
import {operatorServices} from './services.mjs';
// Launch lock: no identities approved/configured yet. Platform verify_jwt=true too.
Deno.serve((req:Request)=>handleOperator(req,{operatorIds:[]},operatorServices({
 projectUrl:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
 accountDid:Deno.env.get('BLUESKY_ACCOUNT_DID'),
})));
