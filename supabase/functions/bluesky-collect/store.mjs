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
  const firstLink = (candidate.links ?? []).map(canonicalLink).find(Boolean);
  const key = firstLink || candidate.uri;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return {uri:candidate.uri,story_key:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),
    actor:candidate.actor,text:candidate.text,source_created_at:candidate.created_at,
    source_url:firstLink ?? null,status:'unverified_review_required'};
}
export async function persist(candidates, config, fetcher=fetch) {
  const url = new URL(config.projectUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password) throw new Error('Invalid project URL');
  const rows = await Promise.all(candidates.map(candidateRow));
  if (!rows.length) return 0;
  // Discard same-story duplicates within batch; unique DB constraint handles other runs.
  const unique = [...new Map(rows.map(row=>[row.story_key,row])).values()];
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
