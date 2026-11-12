-- PROPOSAL ONLY: fresh schema, not applied. CLI-generated migration required.
-- Story grouping is separate from evidence: multiple sources must not be lost.
create table public.warpcore_stories (
 story_key text primary key,
 status text not null default 'unverified_review_required'
 check(status in ('unverified_review_required','approved','rejected','publishing_uncertain','published')),
 collected_at timestamptz not null default now(),
 published_uri text
);
create table public.warpcore_candidates (
 uri text primary key,
 story_key text not null references public.warpcore_stories(story_key),
 source_type text not null,
 source_id text not null,
 actor text not null,
 text text not null,
 source_created_at timestamptz not null,
 source_url text,
 collected_at timestamptz not null default now()
);
create index warpcore_candidates_story on public.warpcore_candidates(story_key);
alter table public.warpcore_stories enable row level security;
alter table public.warpcore_candidates enable row level security;
revoke all on public.warpcore_stories,public.warpcore_candidates from public,anon,authenticated;
grant select,insert,update on public.warpcore_stories,public.warpcore_candidates to service_role;
create function public.warpcore_ingest(items jsonb) returns void
language plpgsql security invoker set search_path = '' as $fn$
begin
 if jsonb_typeof(items) <> 'array' or jsonb_array_length(items)>5000 then
   raise exception 'invalid ingest batch';
 end if;
 insert into public.warpcore_stories(story_key)
 select distinct x.story_key from jsonb_to_recordset(items) as x(story_key text)
 order by x.story_key on conflict do nothing;
 insert into public.warpcore_candidates(uri,story_key,source_type,source_id,actor,text,source_created_at,source_url)
 select uri,story_key,source_type,source_id,actor,text,source_created_at,source_url
 from jsonb_to_recordset(items) as x(uri text,story_key text,source_type text,source_id text,actor text,text text,source_created_at timestamptz,source_url text)
 order by uri on conflict do nothing;
end;
$fn$;
revoke all on function public.warpcore_ingest(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_ingest(jsonb) to service_role;
-- One RPC transaction creates story + evidence atomically, never changes editorial status.
-- No publisher or anonymous access. Hosted/Postgres integration testing remains required.
