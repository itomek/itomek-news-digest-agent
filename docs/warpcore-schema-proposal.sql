-- PROPOSAL ONLY. Not applied. Generate migration using Supabase CLI before committing.
create table public.warpcore_candidates (
  uri text primary key,
  story_key text not null unique,
  actor text not null,
  text text not null,
  source_created_at timestamptz not null,
  source_url text,
  status text not null default 'unverified_review_required'
    check (status in ('unverified_review_required','approved','rejected','publishing_uncertain','published')),
  collected_at timestamptz not null default now(),
  published_uri text
);
alter table public.warpcore_candidates enable row level security;
revoke all on public.warpcore_candidates from anon, authenticated, public;
grant select, insert, update on public.warpcore_candidates to service_role;
-- No anonymous/authenticated policies. Function runtime uses its existing server-only key.
-- Future publisher must atomically claim approved candidates, use deterministic record keys,
-- and reconcile uncertain sends rather than retry blindly. This collector never publishes.

create function public.warpcore_ingest(items jsonb) returns void
language sql security invoker set search_path = '' as $fn$
  insert into public.warpcore_candidates(uri,story_key,actor,text,source_created_at,source_url)
  select uri,story_key,actor,text,source_created_at,source_url
  from jsonb_to_recordset(items) as x(uri text,story_key text,actor text,text text,source_created_at timestamptz,source_url text)
  on conflict do nothing;
$fn$;
revoke all on function public.warpcore_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.warpcore_ingest(jsonb) to service_role;
