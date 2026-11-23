import {repostSubject} from './repost.mjs';
import {deterministicTid} from './publishing.mjs';
import {previewRecord} from './publishing.mjs';
import {sourceLinkDraft} from './source-link-draft.mjs';
const sourceLinkFields=new Set(['mode','storyKey','evidence','approved','verified','articleExcerpt']);
// Credential-free transport preview. Intentionally no fetch, URL, auth, or send API.
export async function prepareTransport(draft,accountDid,preparedAt) {
 if(!/^did:plc:[a-z2-7]{24}$/.test(accountDid))throw Error('Pinned verified account DID required');
 if(typeof preparedAt!=='string'||!Number.isFinite(Date.parse(preparedAt)))throw Error('Persisted preparation time required');
 const createdAt=new Date(preparedAt).toISOString();
 if(draft.mode==='repost'){
  if(draft.verified!==true||draft.approved!==true)throw Error('Verified approved repost required');
  const record={$type:'app.bsky.feed.repost',subject:repostSubject(draft.subject),createdAt};
  // Canonical key order must match SQL canonical JSON for exact native records.
  const material=JSON.stringify({$type:record.$type,createdAt,subject:{cid:record.subject.cid,uri:record.subject.uri}});
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(material));
  return {dryRun:true,publishable:false,request:null,accountDid,recordKey:deterministicTid(draft.storyKey,createdAt),contentHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),record};
 }
 if(draft.mode==='source_link'){
  // This is a preview, never authorization. Only the existing guarded queue
  // can hand a record to the sender. Rebuild text/facets from captured data.
  if(draft.approved!==true||draft.verified!==false||Object.keys(draft).some(k=>!sourceLinkFields.has(k)))throw Error('Exact approved source-link draft required');
  const {text,link}=sourceLinkDraft(draft.evidence,draft.articleExcerpt);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  const facets=[{index:{byteStart:link.byteStart,byteEnd:link.byteEnd},features:[{$type:'app.bsky.richtext.facet#link',uri:link.uri}]}];
  return {dryRun:true,publishable:false,request:null,accountDid,recordKey:deterministicTid(draft.storyKey,createdAt),contentHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),
   record:{$type:'app.bsky.feed.post',text,facets,createdAt}};
 }
 const p=await previewRecord(draft,createdAt), enc=new TextEncoder();
 // Links occur in their own appended lines; start from the end of editorial prose.
 let cursor=[draft.summary.trim(),draft.whyItMatters.trim()].join('\n\n').length;
 const facets=p.links.map(uri=>{const start=p.text.indexOf(uri,cursor);cursor=start+uri.length;
 return {index:{byteStart:enc.encode(p.text.slice(0,start)).length,byteEnd:enc.encode(p.text.slice(0,cursor)).length},features:[{$type:'app.bsky.richtext.facet#link',uri}]};});
 return {dryRun:true,publishable:false,request:null,accountDid,recordKey:p.recordKey,contentHash:p.contentHash,
 record:{$type:'app.bsky.feed.post',text:p.text,facets,createdAt}};
}
