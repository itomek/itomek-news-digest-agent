import {repostSubject} from '../_shared/repost.mjs';
// Internal persistence only. The database enforces uniqueness across concurrent runs.
export function canonicalLink(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}
export async function candidateRow(candidate) {
  const nativeUrl=candidate.native_url == null ? null : canonicalLink(candidate.native_url);
  if(candidate.native_url != null && !nativeUrl)throw Error('Invalid native provenance URL');
  if(candidate.native_uri != null && (typeof candidate.native_uri!=='string'||!candidate.native_uri||candidate.native_uri.length>2048))throw Error('Invalid native provenance identity');
  const sourceLinks=[...new Set([...(candidate.links ?? []).map(canonicalLink).filter(Boolean),...(nativeUrl?[nativeUrl]:[])])];
  if(sourceLinks.length>20)throw Error('Too many source links');
  const firstLink=sourceLinks[0];
  if(candidate.native_cid!=null){const subject=repostSubject({uri:candidate.native_uri,cid:candidate.native_cid});if(candidate.source_type!=='bluesky'||candidate.native_author_did!==subject.uri.split('/')[2])throw Error('Invalid repost evidence');}
  const key = candidate.native_cid!=null?candidate.native_uri:firstLink || candidate.uri;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return {uri:candidate.uri,story_key:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),
    source_type:candidate.source_type ?? 'bluesky',source_id:candidate.source_id ?? candidate.actor,actor:candidate.actor,text:candidate.text,source_created_at:candidate.created_at,
    source_url:firstLink ?? null,source_links:sourceLinks,native_uri:candidate.native_uri ?? null,native_url:nativeUrl,...(candidate.native_cid!=null?{native_cid:candidate.native_cid,native_author_did:candidate.native_author_did}:{}),status:'unverified_review_required'};
}
export async function persist(candidates, config, fetcher=fetch) {
  const url = new URL(config.projectUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password) throw new Error('Invalid project URL');
  const rows = await Promise.all(candidates.map(candidateRow));
  if (!rows.length) return 0;
  // Keep corroborating sources for the same story; deduplicate only origin identifiers.
  const unique = [...new Map(rows.map(row=>[row.uri,row])).values()];
  url.pathname='/rest/v1/rpc/warpcore_ingest'; url.search='';
  const response = await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({items:unique})});
  if (!response.ok) throw new Error('Candidate persistence failed');
  return unique.length; // submitted, not inserted: duplicates may already exist
}
export async function authorized(presented, expected) {
  if (!presented || !expected || expected.length < 32) return false;
  const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [a,b]=await Promise.all([hash(presented),hash(expected)]); let mismatch=0;
  for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
  return mismatch===0;
}
