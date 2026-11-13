-- Read-only review discovery, not a migration or publication authorization.
-- Bind $1 = fixed scan_started_at UTC timestamp from preflight.
-- Bind $2 = NULL on first page, then the last returned story_key (exclusive).
-- 100 is a transport page size ONLY. Fetch until an empty page; no total ceiling.
with newest as (
 select distinct on (s.story_key)
  s.story_key,s.collected_at,c.source_type,c.source_id,c.source_created_at,
  c.source_url,left(c.text,800) as excerpt,c.native_uri,c.native_url,c.source_links
 from public.warpcore_stories s
 join public.warpcore_candidates c using(story_key)
 where s.status='unverified_review_required'
  and s.collected_at <= $1::timestamptz
  and c.collected_at <= $1::timestamptz
  and c.source_created_at between $1::timestamptz-interval '7 days'
                              and $1::timestamptz+interval '5 minutes'
  and ($2::text is null or s.story_key > $2::text)
  and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=s.story_key)
  and not exists(select 1 from public.warpcore_publications p where p.story_key=s.story_key)
 order by s.story_key,c.source_created_at desc,c.uri
)
select * from newest order by story_key limit 100;
