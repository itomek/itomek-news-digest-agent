import {databaseAdapter,blueskyAdapter,readJson} from './adapters.mjs';
import {prepareTransport} from './transport.mjs';
import {sendPrepared,reconcile} from './sender.mjs';
// Internal composition only, not an HTTP endpoint. No account creation/login/refresh.
// A future trusted caller must separately enforce owner-approved editorial scope.
export async function initialize(config,fetcher=fetch){
 if(config.enabled!==true)return {enabled:false};
 if(!/^did:plc:[a-z2-7]{24}$/.test(config.accountDid))throw Error('Pinned DID required');
 const pds=new URL(config.pdsUrl);
 if(pds.protocol!=='https:'||pds.username||pds.password||pds.port||pds.search||pds.hash||pds.pathname!=='/'||!(pds.hostname==='bsky.social'||pds.hostname.endsWith('.bsky.network')))throw Error('Unsupported PDS');
 if(!config.accessToken)throw Error('Existing authorized session required');
 const get=async(url,headers={})=>readJson(await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers}));
 // Public resolution first; never send a credential to an unverified destination.
 const document=await get(`https://plc.directory/${config.accountDid}`);
 const service=document.service?.find(s=>s.id==='#atproto_pds'||s.id===`${config.accountDid}#atproto_pds`);
 if(document.id!==config.accountDid||service?.type!=='AtprotoPersonalDataServer'||service.serviceEndpoint?.replace(/\/$/,'')!==pds.origin)throw Error('PDS does not match DID document');
 const session=await get(`${pds.origin}/xrpc/com.atproto.server.getSession`,{Authorization:`Bearer ${config.accessToken}`});
 if(session.did!==config.accountDid||session.active===false)throw Error('Wrong or inactive session');
 const db=databaseAdapter(config,fetcher),remote=blueskyAdapter({...config,sessionDid:session.did},fetcher);
 return {
  enabled:true,
  runPending:async()=>{
   const jobs=await db.pending(config.accountDid),results=[];
   for(const job of jobs){
    if(job.accountDid!==config.accountDid)throw Error("Queue account mismatch");
    results.push(job.state==='prepared'?await sendPrepared(job,db,remote,{enabled:true,accountDid:config.accountDid}):await reconcile(job,db,remote));
   }
   return results;
  },
  prepareAndSend:async(draft,persistedTime)=>{
   const prepared=await prepareTransport(draft,config.accountDid,persistedTime);
   const job={...prepared,storyKey:draft.storyKey};
   await db.prepare(job);
   return sendPrepared(job,db,remote,{enabled:true,accountDid:config.accountDid});
  },
  reconcile:async storedJob=>{
   if(storedJob.accountDid!==config.accountDid)throw Error('Wrong account');
   return reconcile(storedJob,db,remote);
  },
 };
}
