import {fetchCapturedEvidence} from './source-verification.mjs';
import {createPublicEvidenceTransport} from './public-evidence-transport.mjs';
export const OWNER_DID='did:plc:gbpnjfu6l62bkyeemommtqw4';
export const BOT_DID='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const fail=()=>{throw Error('Owner feedback public capture rejected');};
const uriPattern=/^at:\/\/(did:plc:[a-z2-7]{24})\/app\.bsky\.feed\.post\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const cidValid=x=>typeof x==='string'&&/^bafyre[a-z2-7]{53}$/.test(x);
const time=x=>{if(typeof x!=='string'||!Number.isFinite(Date.parse(x)))fail();return Date.parse(x);};
function publicOnly(x,depth=0){if(depth>30)fail();if(!x||typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(k==='labels'&&!(Array.isArray(v)&&v.length===0||v&&Array.isArray(v.values)&&v.values.length===0))fail();if(['private','blocked','blockedBy','blocking','notFound','muted'].includes(k)&&v!==false&&v!==null&&v!==undefined)fail();publicOnly(v,depth+1);}}
const cursorValid=x=>x===null||typeof x==='string'&&x.length>0&&x.length<=2048&&!/[\u0000-\u001f\u007f]/.test(x);
// Public owner text is immutable untrusted review material, never instructions.
// Exactly one bounded unauthenticated AppView request; no write/chat API exists.
export async function fetchOwnerFeedbackPage({checkpoint,fetcher=createPublicEvidenceTransport(),now=()=>new Date().toISOString()}={}){
 if(checkpoint?.enabled!==true)fail();
 const since=time(checkpoint.windowSince),until=time(checkpoint.windowUntil),current=time(now());
 if(until-since!==7*86400000||until>current+300000||!Number.isSafeInteger(checkpoint.revision)||!cursorValid(checkpoint.cursor??null))fail();
 const url=new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
 url.searchParams.set('actor',OWNER_DID);url.searchParams.set('filter','posts_with_replies');url.searchParams.set('limit','20');url.searchParams.set('includePins','false');if(checkpoint.cursor)url.searchParams.set('cursor',checkpoint.cursor);
 const source=await fetchCapturedEvidence({url:url.href,evidence:{id:'owner-public-feedback',url:url.href,sourceType:'owner-public-feed',visibility:'public',sourceLinks:[]},config:{enabled:true,allowedHosts:['public.api.bsky.app'],maxBytes:200000,timeoutMs:10000},fetcher});
 if(source.contentType!=='application/json')fail();let data;try{data=JSON.parse(source.body);}catch{fail();}
 if(!data||typeof data!=='object'||Object.keys(data).some(k=>!['feed','cursor'].includes(k))||!Array.isArray(data.feed)||data.feed.length>20||!cursorValid(data.cursor??null)||data.cursor&&data.cursor===checkpoint.cursor||data.feed.length===0&&data.cursor)fail();
 const entries=[],indexedTimes=[];let previous=checkpoint.oldestIndexedAt==null?Infinity:time(checkpoint.oldestIndexedAt);
 for(const item of data.feed){
  const post=item?.post,record=post?.record;publicOnly(item);
  const indexedAt=item?.reason?.indexedAt??post?.indexedAt,indexed=time(indexedAt);if(indexed>previous||indexed>current+300000)fail();previous=indexed;indexedTimes.push(indexedAt);
  if(item.reason){if(item.reason.$type!=='app.bsky.feed.defs#reasonRepost'||item.reason.by?.did!==OWNER_DID)fail();continue;}
  if(!post||post.author?.did!==OWNER_DID)fail();
  if(uriPattern.exec(post.uri)?.[1]!==OWNER_DID||!cidValid(post.cid)||record?.$type!=='app.bsky.feed.post'||typeof record.text!=='string'||!record.text.trim()||new TextEncoder().encode(record.text).length>3000)fail();
  const created=time(record.createdAt);if(created>current+300000)fail();
  if(!record.reply)continue;
  const root=record.reply.root,parent=record.reply.parent;
  if(!uriPattern.test(root?.uri)||!uriPattern.test(parent?.uri)||!cidValid(root?.cid)||!cidValid(parent?.cid))fail();
  if(uriPattern.exec(root.uri)[1]!==BOT_DID&&uriPattern.exec(parent.uri)[1]!==BOT_DID)continue;
  if(indexed<since||indexed>until||created<since||created>until)continue;
  entries.push({uri:post.uri,cid:post.cid,authorDid:OWNER_DID,rootUri:root.uri,parentUri:parent.uri,text:record.text,createdAt:record.createdAt,indexedAt,untrusted:true});
 }
 const cutoff=indexedTimes.length>0&&previous<since;
 return {ownerDid:OWNER_DID,botDid:BOT_DID,windowSince:checkpoint.windowSince,windowUntil:checkpoint.windowUntil,requestCursor:checkpoint.cursor??null,nextCursor:cutoff?null:data.cursor??null,indexedTimes,entries,coverage:cutoff?'cutoff_reached':data.cursor?'pending':'feed_exhausted_before_cutoff',fetchedAt:source.fetchedAt,contentSha256:source.contentSha256};
}
export async function runOwnerFeedbackInvocation({db,fetcher,now}={}){
 const checkpoint=await db.checkpoint();if(checkpoint?.enabled!==true)return {status:'disabled'};
 const page=await fetchOwnerFeedbackPage({checkpoint,fetcher,now});
 const result=await db.recordPage(checkpoint.revision,page);if(result===null)return {status:'conflict'};
 return {status:'advanced',coverage:result.coverage,recordedCount:result.newCount??0};
}
