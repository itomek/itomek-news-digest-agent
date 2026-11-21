import {fetchCapturedEvidence} from './source-verification.mjs';
import {validatePublicOriginal} from '../_shared/public-original.mjs';
const fail=()=>{throw Error('Native verification evidence rejected');};
const uriPattern=/^at:\/\/(did:plc:[a-z2-7]{24})\/app\.bsky\.feed\.post\/([234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12})$/;
export function nativeEvidenceIdentity(evidence){
 const match=typeof evidence?.nativeUri==='string'&&uriPattern.exec(evidence.nativeUri);
 if(evidence?.sourceType!=='bluesky'||evidence.visibility!=='public'||!match||evidence.nativeAuthorDid!==match[1]||typeof evidence.nativeCid!=='string'||!/^bafyre[a-z2-7]{53}$/.test(evidence.nativeCid))fail();
 const logical=evidence.nativeUrl??evidence.url;let u;try{u=new URL(logical);}catch{fail();}
 if(typeof logical!=='string'||u.href!==logical||u.protocol!=='https:'||u.username||u.password||u.port||u.hash)fail();
 // Attribution identifies the frozen original, not an arbitrary discovery link.
 // Collector URLs percent-encode the DID; historical captures use literal colons.
 const path=u.pathname.split('/');let author;
 try{author=decodeURIComponent(path[2]);}catch{fail();}
 if(u.hostname!=='bsky.app'||u.search||path.length!==5||path[1]!=='profile'||path[3]!=='post'||author!==match[1]||path[4]!==match[2])fail();
 return {url:logical,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(evidence.nativeUri),nativeUri:evidence.nativeUri,nativeCid:evidence.nativeCid,nativeAuthorDid:evidence.nativeAuthorDid};
}
// Authentication, identity and freshness checks establish only which public
// original was retrieved. Factual support remains an explicitly model judgment.
export function validateNativeCapture(source,evidence,now=new Date().toISOString()){
 const identity=nativeEvidenceIdentity(evidence);
 if(source?.evidenceId!==evidence.id||Object.entries(identity).some(([k,v])=>source[k]!==v)||typeof source.body!=='string'||new TextEncoder().encode(source.body).length>200000)fail();
 let data;try{data=JSON.parse(source.body);}catch{fail();}
 return validatePublicOriginal(data,{uri:identity.nativeUri,cid:identity.nativeCid},identity.nativeAuthorDid,now);
}
export async function fetchNativeEvidence({evidence,fetcher,maxBytes=200000,timeoutMs=10000,now=()=>new Date().toISOString()}={}){
 const identity=nativeEvidenceIdentity(evidence);
 const fetched=await fetchCapturedEvidence({url:identity.fetchedUrl,evidence:{id:evidence.id,url:identity.fetchedUrl,sourceType:'native-public-lookup',visibility:'public',sourceLinks:[]},config:{enabled:true,allowedHosts:['public.api.bsky.app'],maxBytes,timeoutMs:Math.min(timeoutMs,10000)},fetcher});
 if(fetched.contentType!=='application/json')fail();
 const source={evidenceId:evidence.id,url:identity.url,contentSha256:fetched.contentSha256,fetchedAt:fetched.fetchedAt,body:fetched.body,...identity};
 validateNativeCapture(source,evidence,now());return Object.freeze(source);
}
