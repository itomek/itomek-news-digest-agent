// Pure review preparation, not an LLM, fact checker, or source selector.
// Editorial text and review attestations must come from trusted operators, never sources.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value)))))].map(b=>b.toString(16).padStart(2,'0')).join('');
const reviewMaterial=p=>({recordDraft:p.recordDraft,evidence:p.evidence,change:p.change});
export async function createReviewPacket({storyKey,evidence,editorial}){
 if(!/^[a-f0-9]{64}$/.test(storyKey)||!Array.isArray(evidence)||!evidence.length||evidence.length>20)throw Error('Evidence-backed story required');
 if(editorial?.political!==false)throw Error('Political or unclassified items held until explicit scope');
 for(const key of ['summary','whyItMatters','change'])if(typeof editorial[key]!=='string'||!editorial[key].trim()||editorial[key].length>3000)throw Error('Original summary, significance and meaningful change required');
 if(!Array.isArray(editorial.evidenceIds)||!editorial.evidenceIds.length)throw Error('Citations required');
 if(evidence.some(e=>typeof e.id!=='string'||!e.id.trim()||e.id.length>2048||typeof e.sourceType!=='string'||!e.sourceType.trim()||e.visibility!=='public')||editorial.evidenceIds.some(id=>typeof id!=='string'||!id.trim()))throw Error('Typed public evidence provenance required');
 const ids=new Set(evidence.map(e=>e.id));if(ids.size!==evidence.length||editorial.evidenceIds.some(id=>!ids.has(id)))throw Error('Invalid evidence reference');
 const selected=evidence.filter(e=>editorial.evidenceIds.includes(e.id)).map(e=>{
  const url=new URL(e.url);if(url.protocol!=='https:'||url.username||url.password||typeof e.text!=='string'||!e.text.trim()||e.text.length>20000)throw Error('Public evidence required');
  if(editorial.summary.trim()===e.text.trim())throw Error('Raw repost is not editorial summary');
  const safeLink=raw=>{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)throw Error('Invalid attribution URL');return u.toString();};
  if(e.sourceLinks!==undefined&&(!Array.isArray(e.sourceLinks)||e.sourceLinks.length>20))throw Error('Invalid attribution links');
  if(e.nativeUri!=null&&(typeof e.nativeUri!=='string'||!e.nativeUri||e.nativeUri.length>2048))throw Error('Invalid native identity');
  const nativeUrl=e.nativeUrl == null ? null : safeLink(e.nativeUrl);
  const sourceLinks=[...new Set([url.toString(),...(e.sourceLinks??[]).map(safeLink),...(nativeUrl?[nativeUrl]:[])])];
  return {id:e.id,url:url.toString(),text:e.text,sourceType:e.sourceType,visibility:e.visibility,nativeUri:e.nativeUri??null,nativeUrl,sourceLinks};
 });
 const attributionLinks=[...new Set(selected.flatMap(e=>e.sourceLinks))];
 if(attributionLinks.length>3)throw Error('Too many attribution links; narrow evidence rather than silently dropping credit');
 const packet={status:'awaiting_review',approved:false,change:editorial.change.trim(),evidence:selected,
 recordDraft:{storyKey,summary:editorial.summary.trim(),whyItMatters:editorial.whyItMatters.trim(),links:attributionLinks}};
 return {...packet,contentHash:await digest(reviewMaterial(packet))};
}
export async function approveReview(packet,review){
 if(review?.contentHash!==packet.contentHash||await digest(reviewMaterial(packet))!==packet.contentHash||review.factsVerified!==true||review.meaningfulChange!==true||review.scopeApproved!==true)throw Error('Exact verified review required');
 return {...packet.recordDraft,verified:true,approved:true};
}
