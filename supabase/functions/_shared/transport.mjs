import {previewRecord} from './publishing.mjs';
// Credential-free transport preview. Intentionally no fetch, URL, auth, or send API.
export async function prepareTransport(draft,accountDid,preparedAt) {
 if(!/^did:plc:[a-z2-7]{24}$/.test(accountDid))throw Error('Pinned verified account DID required');
 if(typeof preparedAt!=='string'||!Number.isFinite(Date.parse(preparedAt)))throw Error('Persisted preparation time required');
 const p=await previewRecord(draft), enc=new TextEncoder();
 // Links occur in their own appended lines; start from the end of editorial prose.
 let cursor=[draft.summary.trim(),draft.whyItMatters.trim()].join('\n\n').length;
 const facets=p.links.map(uri=>{const start=p.text.indexOf(uri,cursor);cursor=start+uri.length;
 return {index:{byteStart:enc.encode(p.text.slice(0,start)).length,byteEnd:enc.encode(p.text.slice(0,cursor)).length},features:[{$type:'app.bsky.richtext.facet#link',uri}]};});
 return {dryRun:true,publishable:false,request:null,accountDid,recordKey:p.recordKey,contentHash:p.contentHash,
 record:{$type:'app.bsky.feed.post',text:p.text,facets,createdAt:new Date(preparedAt).toISOString()}};
}
