import {readJson} from './adapters.mjs';
// Internal server-only boundary. Never log this return value or persist tokens.
// One login per invocation, no retries/redirects. Scheduler must stay hourly.
export async function connect(config,fetcher=fetch){
 if(config.enabled!==true)return {enabled:false};
 if(!/^did:plc:[a-z2-7]{24}$/.test(config.accountDid)||config.identifier!=='warp-core.bsky.social'||typeof config.appPassword!=='string'||!config.appPassword.trim())throw Error('Account configuration required');
 const request=async(url,options={})=>readJson(await fetcher(url,{method:'GET',...options,redirect:'error',signal:AbortSignal.timeout(10000)}));
 const resolved=await request(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(config.identifier)}`);
 if(resolved.did!==config.accountDid)throw Error('Handle identity mismatch');
 const doc=await request(`https://plc.directory/${config.accountDid}`);
 const service=doc.service?.find(s=>s.id==='#atproto_pds'||s.id===`${config.accountDid}#atproto_pds`);
 if(doc.id!==config.accountDid||service?.type!=='AtprotoPersonalDataServer')throw Error('DID service mismatch');
 const pds=new URL(service.serviceEndpoint);
 if(pds.protocol!=='https:'||pds.username||pds.password||pds.port||pds.search||pds.hash||pds.pathname!=='/'||!(pds.hostname==='bsky.social'||pds.hostname.endsWith('.bsky.network')))throw Error('Untrusted PDS');
 const s=await request(`${pds.origin}/xrpc/com.atproto.server.createSession`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:config.accountDid,password:config.appPassword})});
 if(s.did!==config.accountDid||s.active===false||typeof s.accessJwt!=='string'||!s.accessJwt)throw Error('Session identity mismatch');
 return {enabled:true,accountDid:config.accountDid,pdsUrl:pds.origin,accessToken:s.accessJwt};
}
export async function initializeWithPassword(config,init,connector=connect){
 if(config.enabled!==true)return {enabled:false};
 const session=await connector(config);
 return init({...session,projectUrl:config.projectUrl,serviceKey:config.serviceKey});
}
