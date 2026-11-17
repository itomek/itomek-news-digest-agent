-- SYNTHETIC NONPUBLISHING SPIKE. REVIEW BEFORE APPLYING TO A DISPOSABLE PROJECT.
-- Never run in the live news project. This file neither creates budgets nor
-- enables the producer. No credentials, external calls, cron or publisher exist.
-- Install this FIRST, then separately review/install the four shadow contracts.
-- This deliberately refuses reinstall and any existing Warp Core relations.
begin;
do $$
begin
 if exists(select 1 from pg_namespace where nspname='shadow_agent')
 or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and left(c.relname,9)='warpcore_')
 then raise exception 'Refusing spike fixture install: existing Warp Core relation or shadow_agent schema'; end if;
end $$;
create table public.warpcore_stories (
 story_key text primary key check(story_key ~ '^[a-f0-9]{64}$'),
 status text not null check(status='unverified_review_required'),
 collected_at timestamptz not null,
 fixture_kind text not null default 'synthetic-nonpublishing-spike-v1'
 check(fixture_kind='synthetic-nonpublishing-spike-v1')
);
create table public.warpcore_candidates (
 uri text primary key,
 story_key text not null references public.warpcore_stories(story_key),
 source_type text not null check(source_type='rss'),
 source_created_at timestamptz not null, source_url text not null check(source_url like 'https://example.com/%'),
 text text not null check(text like 'SYNTHETIC NONPUBLISHING SPIKE%'),
 collected_at timestamptz not null,
 fixture_kind text not null default 'synthetic-nonpublishing-spike-v1'
 check(fixture_kind='synthetic-nonpublishing-spike-v1')
);
-- Empty structural stand-ins required by the read-only exclusion query.
-- CHECK(false) keeps these empty even if a privileged caller inserts by mistake.
create table public.warpcore_curator_inbox (
 story_key text primary key, constraint spike_inbox_must_stay_empty check(false)
);
create table public.warpcore_publications (
 story_key text primary key, constraint spike_publications_must_stay_empty check(false)
);
alter table public.warpcore_stories enable row level security;
alter table public.warpcore_candidates enable row level security;
alter table public.warpcore_curator_inbox enable row level security;
alter table public.warpcore_publications enable row level security;
revoke all on public.warpcore_stories,public.warpcore_candidates,public.warpcore_curator_inbox,public.warpcore_publications
 from public,anon,authenticated,service_role;
-- One source, 405 distinct ordered story identities: four full pages, a final
-- meaningful five-story page and an empty terminal page. Every word is synthetic.
insert into public.warpcore_stories(story_key,status,collected_at)
 select lpad(to_hex(n),64,'0'),'unverified_review_required',clock_timestamp()-interval '1 minute'
 from generate_series(1,405) n;
insert into public.warpcore_candidates(uri,story_key,source_type,source_created_at,source_url,text,collected_at)
 select 'synthetic-spike-rss-'||s.story_key,s.story_key,'rss',s.collected_at,
 'https://example.com/warpcore-synthetic-spike/'||s.story_key,
 'SYNTHETIC NONPUBLISHING SPIKE fixture '||s.story_key||'. This fabricated discovery story exercises coverage only; it is not factual source evidence or model quality acceptance.',
 s.collected_at from public.warpcore_stories s;
comment on table public.warpcore_stories is 'SYNTHETIC NONPUBLISHING SPIKE ONLY. Disposable fixture; never production data.';
comment on table public.warpcore_candidates is 'SYNTHETIC NONPUBLISHING SPIKE ONLY. One RSS source, 405 fabricated discoveries.';
comment on table public.warpcore_curator_inbox is 'SYNTHETIC SPIKE STRUCTURE ONLY. Must remain empty; no publishing route.';
comment on table public.warpcore_publications is 'SYNTHETIC SPIKE STRUCTURE ONLY. Must remain empty; no publisher installed.';
commit;
