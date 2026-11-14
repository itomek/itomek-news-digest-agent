// Discovery only. No source fetching, verification, editorial decisions or writes.
// A malformed row fails the entire page: never silently skip part of a full scan.
// Caller must keep scanStartedAt fixed and paginate until an EMPTY page, not a
// short page. Live exclusions can change; 100 is transport size, never a quota.
const key=/^[0-9a-f]{64}$/;
function utc(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return false;
 const time=Date.parse(value);if(!Number.isFinite(time))return false;
 return new Date(time).toISOString()===value.replace(/(?:\.(\d{1,3}))?Z$/,(_,fraction)=>'.'+(fraction??'').padEnd(3,'0')+'Z');
}
const sql=`with newest as (
 select distinct on (s.story_key)
  s.story_key,c.source_type,c.source_created_at,c.source_url,left(c.text,800) as excerpt
 from public.warpcore_stories s join public.warpcore_candidates c using(story_key)
 where s.status='unverified_review_required'
  and s.collected_at <= $1::timestamptz and c.collected_at <= $1::timestamptz
  and c.source_created_at between $1::timestamptz-interval '7 days' and $1::timestamptz+interval '5 minutes'
  and ($2::text is null or s.story_key > $2::text)
  and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=s.story_key)
  and not exists(select 1 from public.warpcore_publications p where p.story_key=s.story_key)
 order by s.story_key,c.source_created_at desc,c.uri
)
select story_key,source_type,source_url,excerpt,
 to_char(source_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as source_created_at
from newest order by story_key limit 100`;
export function createCandidateSource({query}={}){
 if(typeof query!=='function')throw Error('Candidate query dependency required');
 return async function fetchPage({scanStartedAt,cursor=null}={}){
  if(!utc(scanStartedAt))throw Error('Strict UTC scan timestamp required');
  if(cursor!==null&&(typeof cursor!=='string'||!key.test(cursor)))throw Error('Invalid candidate cursor');
  const result=await query(sql,[scanStartedAt,cursor]);
  if(!result||!Array.isArray(result.rows)||result.rows.length>100)throw Error('Invalid candidate page');
  let last=cursor;const scan=Date.parse(scanStartedAt);
  return result.rows.map(row=>{
   if(!row||typeof row.story_key!=='string'||!key.test(row.story_key)||(last!==null&&row.story_key<=last)||typeof row.source_type!=='string'||!row.source_type.trim()||typeof row.excerpt!=='string'||!row.excerpt.trim()||typeof row.source_url!=='string'||!utc(row.source_created_at))throw Error('Invalid candidate row');
   const time=Date.parse(row.source_created_at);
   if(time<scan-7*86400000||time>scan+300000)throw Error('Invalid candidate date');
   let url;try{url=new URL(row.source_url);}catch{throw Error('Invalid candidate URL');}
   if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid candidate URL');
   last=row.story_key;
   return {id:row.story_key,sourceUrl:row.source_url,sourceType:row.source_type,sourceCreatedAt:row.source_created_at,discoveryText:row.excerpt};
  });
 };
}
