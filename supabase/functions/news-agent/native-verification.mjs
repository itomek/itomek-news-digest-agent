import {fetchCapturedEvidence} from './source-verification.mjs';
const fail=()=>{throw Error('Native verification evidence rejected');};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uriPattern=/^at:\/\/(did:plc:[a-z2-7]{24})\/app\.bsky\.feed\.post\/([234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12})$/;
export function nativeEvidenceIdentity(evidence){
 const match=typeof evidence?.nativeUri==='string'&&uriPattern.exec(evidence.nativeUri);
 if(evidence?.sourceType!=='bluesky'||evidence.visibility!=='public'||!match||evidence.nativeAuthorDid!==match[1]||typeof evidence.nativeCid!=='string'||!/^bafyre[a-z2-7]{53}$/.test(evidence.nativeCid))fail();
 const logical=evidence.nativeUrl??evidence.url;let u;try{u=new URL(logical);}catch{fail();}
 if(typeof logical!=='string'||u.href!==logical||u.protocol!=='https:'||u.username||u.password||u.port||u.hash)fail();
 return {url:logical,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(evidence.nativeUri),nativeUri:evidence.nativeUri,nativeCid:evidence.nativeCid,nativeAuthorDid:evidence.nativeAuthorDid};
}
function warningLabels(value,depth=0){
 if(depth>40)fail();
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){
  if(key==='labels'&&!(Array.isArray(child)&&child.length===0||plain(child)&&Array.isArray(child.values)&&child.values.length===0))fail();
  if(['blocked','blockedBy','blocking','notFound','private','muted'].includes(key)&&child!==false&&child!==null&&child!==undefined)fail();
  warningLabels(child,depth+1);
 }
}
// Authentication, identity and freshness checks establish only which public
// original was retrieved. Factual support remains an explicitly model judgment.
export function validateNativeCapture(source,evidence,now=new Date().toISOString()){
 const identity=nativeEvidenceIdentity(evidence);
 if(source?.evidenceId!==evidence.id||Object.entries(identity).some(([k,v])=>source[k]!==v)||typeof source.body!=='string'||new TextEncoder().encode(source.body).length>200000)fail();
 let data;try{data=JSON.parse(source.body);}catch{fail();}
 if(!plain(data)||!Array.isArray(data.posts)||data.posts.length!==1||Object.keys(data).some(k=>k!=='posts'))fail();
 const post=data.posts[0],record=post?.record;
 if(!plain(post)||post.uri!==identity.nativeUri||post.cid!==identity.nativeCid||post.author?.did!==identity.nativeAuthorDid
 ||post.$type!==undefined&&post.$type!=='app.bsky.feed.defs#postView'||!plain(record)||record.$type!=='app.bsky.feed.post'
 ||typeof record.text!=='string'||!record.text.trim()||record.text.length>3000||typeof record.createdAt!=='string')fail();
 warningLabels(post);
 const created=Date.parse(record.createdAt),time=Date.parse(now);
 if(!Number.isFinite(created)||!Number.isFinite(time)||created>time+300000||created<time-7*86400000)fail();
 return {text:record.text,createdAt:record.createdAt,publicationDate:new Date(created).toISOString().slice(0,10),subject:{uri:post.uri,cid:post.cid}};
}
export async function fetchNativeEvidence({evidence,fetcher,maxBytes=200000,timeoutMs=10000,now=()=>new Date().toISOString()}={}){
 const identity=nativeEvidenceIdentity(evidence);
 const fetched=await fetchCapturedEvidence({url:identity.fetchedUrl,evidence:{id:evidence.id,url:identity.fetchedUrl,sourceType:'native-public-lookup',visibility:'public',sourceLinks:[]},config:{enabled:true,allowedHosts:['public.api.bsky.app'],maxBytes,timeoutMs:Math.min(timeoutMs,10000)},fetcher});
 if(fetched.contentType!=='application/json')fail();
 const source={evidenceId:evidence.id,url:identity.url,contentSha256:fetched.contentSha256,fetchedAt:fetched.fetchedAt,body:fetched.body,...identity};
 validateNativeCapture(source,evidence,now());return Object.freeze(source);
}
