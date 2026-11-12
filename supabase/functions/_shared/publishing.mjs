// Offline editorial/publishing boundary. No credential, sender or network access.
// verified/approved are trusted reviewer attestations, NOT source-provided fields.
export function preview(draft) {
 if(!draft || !/^[a-f0-9]{64}$/.test(draft.storyKey) || draft.verified!==true || draft.approved!==true)throw new Error('Verified approved story required');
 for(const key of ['summary','whyItMatters'])if(typeof draft[key]!=='string'||!draft[key].trim())throw new Error('Editorial text required');
 if(!Array.isArray(draft.links)||!draft.links.length||draft.links.length>3)throw new Error('Evidence links required');
 const links=draft.links.map(raw=>{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Public HTTPS evidence required');return u.toString();});
 const text=[draft.summary.trim(),draft.whyItMatters.trim(),...links].join('\n\n');
 const graphemes=[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(text)].length;
 if(graphemes>300 || new TextEncoder().encode(text).length>3000)throw new Error('Post exceeds Bluesky limits; edit, do not truncate evidence');
 return {mode:'dry_run',publishable:false,text,links,graphemes};
}
export async function previewRecord(draft) {
 const result=preview(draft);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.text));
 // Stable per story, so a changed summary cannot silently create a second post.
 return {...result,recordKey:`story-${draft.storyKey}`,contentHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};
}
export function nextAction(state, remote) {
 if(state==='published')return 'skip';
 if(state==='prepared')return 'await_authorization';
 if(state==='sending'||state==='uncertain'){
  if(!remote)return 'reconcile';
  return remote.matches===true?'mark_published':'manual_review';
 }
 return 'manual_review';
}
