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
// app.bsky.feed.post requires a TID, not merely generic record-key syntax.
// Use the persisted record timestamp, never a fresh wall clock on a retry.
export function deterministicTid(storyKey,preparedAt) {
 if(typeof storyKey!=='string'||!/^[a-f0-9]{64}$/.test(storyKey)||typeof preparedAt!=='string')throw Error('Persisted story and timestamp required');
 const milliseconds=Date.parse(preparedAt);
 if(!Number.isSafeInteger(milliseconds))throw Error('Invalid timestamp');
 const micros=BigInt(milliseconds)*1000n;
 if(micros<0n||micros>=(1n<<53n))throw Error('Timestamp outside TID range');
 const clock=BigInt('0x'+storyKey.slice(0,3))>>2n;
 let value=(micros<<10n)|clock, key='';
 const alphabet='234567abcdefghijklmnopqrstuvwxyz';
 for(let i=0;i<13;i++){key=alphabet[Number(value&31n)]+key;value>>=5n;}
 return key;
}
export async function previewRecord(draft,preparedAt) {
 const result=preview(draft);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.text));
 // Stable for a persisted story+timestamp; database account/story PK prevents repreparation.
 return {...result,recordKey:deterministicTid(draft.storyKey,preparedAt),contentHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};
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
