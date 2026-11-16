import {handleAgent} from '../../supabase/functions/news-agent/handler.mjs';
import {createSpikeService} from '../../supabase/functions/news-agent-spike/spike.mjs';
const REF='haloshadowlocal00001';
const ORIGIN=`https://${REF}.supabase.co`;
const encoder=new TextEncoder();
function decodePart(value){
 if(typeof value!=='string'||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid JWT encoding');
 const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
 const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 // Reject alternate noncanonical encodings of the signed token components.
 const canonical=btoa(binary).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
 if(canonical!==value)throw Error('Invalid JWT encoding');
 return bytes;
}
async function serviceJWT(header,secret){
 try{
  if(typeof secret!=='string'||secret.length<32||secret.length>4096||typeof header!=='string'||header.length>8192)return null;
  const match=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if(!match)return null;
  const token=match[1],parts=token.split('.');
  const json=part=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decodePart(part)));
  const metadata=json(parts[0]),claims=json(parts[1]);
  if(!metadata||Array.isArray(metadata)||metadata.alg!=='HS256'||metadata.typ!=='JWT'||Object.keys(metadata).some(k=>!['alg','typ'].includes(k))||!claims||Array.isArray(claims)||claims.role!=='service_role'||!Number.isSafeInteger(claims.exp)||claims.exp<=Math.floor(Date.now()/1000))return null;
  if(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>Math.floor(Date.now()/1000)))return null;
  const signature=decodePart(parts[2]);if(signature.byteLength!==32)return null;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,signature,encoder.encode(parts[0]+'.'+parts[1])))return null;
  return token;
 }catch{return null;}
}
// Local StrixHalo fixture boundary only. No listener at import, cloud project,
// provider request, production connection, host override or credentials lookup.
export async function handleHaloShadow(req,env={},fetcher=fetch){
 if(req.method!=='POST')return new Response('POST required',{status:405});
 const jwt=await serviceJWT(req.headers.get('authorization'),env.JWT_SECRET);
 if(jwt===null)return new Response('Unauthorized',{status:401});
 let service;
 const getService=()=>{
  if(!service){
   const localDB=(raw,options)=>{
    const url=new URL(raw);
    if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!/^\/rest\/v1\/rpc\/warpcore_shadow_[a-z_]+$/.test(url.pathname))throw Error('Local shadow destination refused');
    // Trusted local-only fault injection: prove an unconfirmed accounting write
    // retains the dispatched hold without changing any cloud/provider path.
    if(env.HALO_SHADOW_TEST_DROP_SETTLEMENT==='true'&&url.pathname==='/rest/v1/rpc/warpcore_shadow_paged_settle')return Response.json({error:'synthetic_local_settlement_drop'},{status:503});
    return fetcher(new URL(url.pathname.slice('/rest/v1'.length),'http://postgrest:3000'),options);
   };
   const leaseSeconds=env.HALO_SHADOW_LEASE_SECONDS===undefined?10:Number(env.HALO_SHADOW_LEASE_SECONDS);
   service=createSpikeService({projectRef:REF,projectUrl:ORIGIN,serviceKey:jwt,enabled:true,leaseSeconds},localDB);
  }
  return service;
 };
 return handleAgent(req,{enabled:env.HALO_SHADOW_ENABLED==='true',producerToken:env.WARPCORE_AGENT_PRODUCER_TOKEN},{
  selectRun:()=>getService().selectRun(),
  runInvocation:runId=>getService().runInvocation(runId),
 });
}
